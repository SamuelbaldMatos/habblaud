// Compositor compacto do Chat OmniRoute, com conversa e atividade expansíveis sob demanda.
import { OMNIROUTE_COMBO_OPTIONS } from '../../../shared/omniroute-combos';
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, setAttr, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { parseOmniRouteStreamEvent, type OmniRouteApproval, type OmniRouteStreamEvent } from './chat-stream';

type ChatAgentEvent =
  | Extract<OmniRouteStreamEvent, { type: 'activity' }>
  | Extract<OmniRouteStreamEvent, { type: 'approval' }>
  | Extract<OmniRouteStreamEvent, { type: 'tool_result' }>;

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  combo?: string;
  model?: string;
  time: number;
  events?: ChatAgentEvent[];
  jobId?: string;
}

export const COMBOS = OMNIROUTE_COMBO_OPTIONS;

export class OmniChatPanel implements UiComponent {
  readonly el: HTMLElement;
  private readonly messagesList: HTMLElement;
  private readonly inputArea: HTMLTextAreaElement;
  private readonly comboSelect: HTMLSelectElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly tabChatBtn: HTMLButtonElement;
  private readonly tabActivityBtn: HTMLButtonElement;
  private readonly activityView: HTMLElement;
  private readonly chatView: HTMLElement;
  private readonly splitToggleBtn: HTMLButtonElement;

  private messages: ChatMsg[] = [];
  private currentTab: 'chat' | 'activity' = 'chat';
  private abortController: AbortController | null = null;
  private isStreaming = false;
  private isExpanded = false;
  private currentJobId: string | null = null;

  constructor(private readonly ctx: UiContext) {
    this.messages = this.loadStoredMessages().map((message) => ({
      ...message,
      events: message.events?.map((event) => event.type === 'approval' && !event.approval.status
        ? { ...event, approval: { ...event.approval, status: 'expired' } }
        : event),
    }));
    if (!this.messages.length) {
      this.messages.push({
        id: 'init-msg',
        role: 'assistant',
        content: '👋 Olá! Com **orquestrador**, posso coordenar especialistas, ler arquivos do workspace e propor alterações ou verificações. Cada escrita e comando pede sua aprovação explícita. Selecione outro combo para uma consulta direta.',
        combo: 'orquestrador',
        time: Date.now(),
      });
    }

    // ---------------------------------------------------------------- Elementos de Controle
    this.tabChatBtn = h('button', {
      class: 'omni-tab-btn is-active',
      text: '💬 Chat OmniRoute',
      on: { click: () => this.setTab('chat') },
    });

    this.tabActivityBtn = h('button', {
      class: 'omni-tab-btn',
      text: '🖥️ Atividade & Código',
      on: { click: () => this.setTab('activity') },
    });

    this.splitToggleBtn = iconButton('▴', 'Expandir conversa (Alt+S)', () => this.toggleConversation(), 'omni-split-btn');
    this.splitToggleBtn.setAttribute('aria-expanded', 'false');

    this.comboSelect = h('select', {
      class: 'omni-combo-select',
      attrs: { 'aria-label': 'Selecionar Combo OmniRoute' },
    }, ...COMBOS.map((c) => h('option', { attrs: { value: c.id }, text: c.label })));

    this.inputArea = h('textarea', {
      class: 'omni-chat-input',
      attrs: {
        placeholder: 'Envie uma instrução ou pergunta para o OmniRoute... (Enter envia, Shift+Enter nova linha)',
        rows: '1',
      },
      on: {
        input: () => this.autoResizeInput(),
        keydown: (e: KeyboardEvent) => this.handleKeyDown(e),
      },
    }) as HTMLTextAreaElement;

    this.sendBtn = h('button', {
      class: 'omni-send-btn',
      attrs: { title: 'Enviar mensagem (Enter)' },
      on: { click: () => this.sendCurrentMessage() },
    }, h('span', { text: '➤' }), h('span', { text: 'Enviar' }));

    this.stopBtn = h('button', {
      class: 'omni-stop-btn is-hidden',
      attrs: { title: 'Interromper resposta' },
      on: { click: () => this.stopStreaming() },
    }, h('span', { text: '⏹ Parar' }));

    this.clearBtn = iconButton('🗑', 'Limpar conversa', () => this.clearChat(), 'omni-clear-btn');

    // ---------------------------------------------------------------- Estrutura do Painel
    this.messagesList = h('div', { class: 'omni-messages-list' });
    this.activityView = h('div', { class: 'omni-activity-view is-hidden' });
    this.chatView = h('div', { class: 'omni-chat-view' }, this.messagesList);

    const header = h('header', {
      class: 'omni-panel-header',
    },
        h('div', { class: 'omni-tabs-group' }, this.tabChatBtn, this.tabActivityBtn),
        h('div', { class: 'omni-header-actions' }, this.clearBtn),
      );

    const footer = h('footer', {
      class: 'omni-chat-footer',
    }, h('div', { class: 'omni-composer-row' },
      this.comboSelect,
      h('div', { class: 'omni-input-wrapper' }, this.inputArea, this.sendBtn, this.stopBtn),
      this.splitToggleBtn,
    ));

    this.el = h('aside', {
      class: 'omni-workspace-panel is-collapsed',
      attrs: { 'aria-label': 'Workspace e Chat OmniRoute' },
    }, header, this.chatView, this.activityView, footer);

    this.renderMessages();
    this.updateExpandedClass();

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        this.toggleConversation();
      }
    });
  }

  toggleConversation(force?: boolean): void {
    this.isExpanded = force ?? !this.isExpanded;
    this.updateExpandedClass();
    this.autoResizeInput();
    this.ctx.invalidate();
  }

  private updateExpandedClass(): void {
    this.el.classList.toggle('is-expanded', this.isExpanded);
    this.el.classList.toggle('is-collapsed', !this.isExpanded);
    this.ctx.root.classList.toggle('has-omni-split', this.isExpanded);
    setHidden(this.chatView, !this.isExpanded || this.currentTab !== 'chat');
    setHidden(this.activityView, !this.isExpanded || this.currentTab !== 'activity');
    setAttr(this.splitToggleBtn, 'title', this.isExpanded ? 'Recolher conversa (Alt+S)' : 'Expandir conversa (Alt+S)');
    this.splitToggleBtn.setAttribute('aria-expanded', String(this.isExpanded));
    this.splitToggleBtn.textContent = this.isExpanded ? '▾' : '▴';
  }

  private setTab(tab: 'chat' | 'activity'): void {
    this.currentTab = tab;
    this.tabChatBtn.classList.toggle('is-active', tab === 'chat');
    this.tabActivityBtn.classList.toggle('is-active', tab === 'activity');
    setHidden(this.chatView, !this.isExpanded || tab !== 'chat');
    setHidden(this.activityView, !this.isExpanded || tab !== 'activity');
    if (tab === 'activity') this.renderActivity();
  }

  private autoResizeInput(): void {
    this.inputArea.style.height = 'auto';
    this.inputArea.style.height = `${this.isExpanded ? Math.min(this.inputArea.scrollHeight, 180) : 28}px`;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendCurrentMessage();
    }
  }

  private clearChat(): void {
    if (this.isStreaming) this.stopStreaming();
    this.messages = [];
    this.saveMessages();
    this.renderMessages();
  }

  private stopStreaming(): void {
    const controller = this.abortController;
    const jobId = this.currentJobId;
    const lastMessage = this.messages[this.messages.length - 1];
    for (const event of lastMessage?.events ?? []) {
      if (event.type === 'approval' && !event.approval.status) event.approval.status = 'expired';
    }
    this.abortController = null;
    this.currentJobId = null;
    controller?.abort();
    if (jobId) {
      void fetch(`/api/omniroute/jobs/${jobId}`, { method: 'DELETE' }).then(async (response) => {
        if (!response.ok && response.status !== 404) throw new Error(`Falha ao cancelar tarefa (HTTP ${response.status})`);
      }).catch((error: unknown) => console.error('Falha ao cancelar tarefa multiagente:', error));
    }
    this.isStreaming = false;
    setHidden(this.sendBtn, false);
    setHidden(this.stopBtn, true);
    this.inputArea.disabled = false;
    this.saveMessages();
    this.renderMessages();
  }

  async sendCurrentMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    if (!text || this.isStreaming) return;

    this.inputArea.value = '';
    this.autoResizeInput();

    const combo = this.comboSelect.value;
    const userMsg: ChatMsg = {
      id: `usr-${Date.now()}`,
      role: 'user',
      content: text,
      time: Date.now(),
    };

    this.messages.push(userMsg);
    this.saveMessages();
    this.renderMessages();

    // Cria a mensagem assistente em streaming
    const assistantId = `ast-${Date.now()}`;
    const assistantMsg: ChatMsg = {
      id: assistantId,
      role: 'assistant',
      content: '',
      combo,
      time: Date.now(),
    };

    this.messages.push(assistantMsg);
    this.renderMessages();
    this.scrollToBottom();

    this.isStreaming = true;
    setHidden(this.sendBtn, true);
    setHidden(this.stopBtn, false);
    this.inputArea.disabled = true;

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const isManager = combo === 'orquestrador';
      const response = await fetch(isManager ? '/api/omniroute/run' : '/api/omniroute/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isManager
          ? {
              message: text,
              messages: this.messages
                .filter((message) => message.id !== userMsg.id && message.id !== assistantId && message.id !== 'init-msg')
                .filter((message) => message.role === 'user' || message.role === 'assistant')
                .slice(-10)
                .map((message) => ({ role: message.role, content: message.content })),
            }
          : { combo, messages: this.messages.slice(-10, -1).map((m) => ({ role: m.role, content: m.content })) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || `Erro HTTP ${response.status}`);
      }

      if (!response.body) throw new Error('Resposta vazia');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) return;
        const event = parseOmniRouteStreamEvent(trimmed.slice(5).trim());
        if (event.type === 'done') return;
        if (event.type === 'job') {
          this.currentJobId = event.jobId;
          assistantMsg.jobId = event.jobId;
        } else if (event.type === 'data') {
          if (event.text) {
            assistantMsg.content += event.text;
            this.updateStreamingMessage(assistantId, assistantMsg.content);
            this.scrollToBottom();
          }
          if (event.model) assistantMsg.model = event.model;
        } else if (event.type === 'activity') {
          (assistantMsg.events ??= []).push(event);
          this.appendActivity(assistantId, event.activity);
        } else if (event.type === 'approval') {
          (assistantMsg.events ??= []).push(event);
          this.appendApproval(assistantId, event.approval, this.currentJobId);
        } else if (event.type === 'tool_result') {
          (assistantMsg.events ??= []).push(event);
          this.appendToolResult(assistantId, event.result);
        } else if (event.type === 'error') {
          assistantMsg.content += `${assistantMsg.content ? '\n\n' : ''}⚠️ ${event.error}`;
          this.updateStreamingMessage(assistantId, assistantMsg.content);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buf += decoder.decode();
          if (buf) processLine(buf);
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) processLine(line);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        assistantMsg.content += `\n\n⚠️ *Falha ao comunicar com OmniRoute: ${(err as Error).message}*`;
        this.updateStreamingMessage(assistantId, assistantMsg.content);
      }
    } finally {
      if (this.abortController === controller) {
        for (const event of assistantMsg.events ?? []) {
          if (event.type === 'approval' && !event.approval.status) event.approval.status = 'expired';
        }
        this.abortController = null;
        this.currentJobId = null;
        this.isStreaming = false;
        setHidden(this.sendBtn, false);
        setHidden(this.stopBtn, true);
        this.inputArea.disabled = false;
        this.saveMessages();
        this.renderMessages();
        this.inputArea.focus();
      }
    }
  }

  private updateStreamingMessage(id: string, text: string): void {
    const el = this.messagesList.querySelector(`[data-msg-id="${id}"] .omni-msg-body`);
    if (el) {
      el.textContent = '';
      el.append(renderMarkdown(text));
      this.enhanceCodeBlocks(el as HTMLElement);
    }
  }

  private appendActivity(id: string, text: string): void {
      const body = this.messagesList.querySelector(`[data-msg-id="${id}"] .omni-msg-body`);
      body?.append(h('p', { class: 'omni-agent-activity', text }));
      this.scrollToBottom();
    }

  private appendApproval(id: string, approval: OmniRouteApproval, jobId: string | null): void {
      const body = this.messagesList.querySelector(`[data-msg-id="${id}"] .omni-msg-body`);
      if (!body) return;
      const card = h('section', { class: 'omni-approval-card', attrs: { 'aria-label': 'Aprovação necessária' } });
      card.append(
        h('strong', { text: approval.kind === 'write' ? '✍️ Aprovação de escrita necessária' : '▶️ Aprovação de comando necessária' }),
        h('p', { text: approval.summary }),
      );
      if (approval.path && approval.oldContent !== undefined && approval.newContent !== undefined) {
        const details = h('details', { class: 'omni-approval-preview' },
          h('summary', { text: `Revisar conteúdo de ${approval.path}` }),
          h('div', { class: 'omni-approval-version' }, h('strong', { text: 'Conteúdo atual' }), h('pre', { text: approval.oldContent })),
          h('div', { class: 'omni-approval-version' }, h('strong', { text: 'Conteúdo proposto' }), h('pre', { text: approval.newContent })),
        );
        card.append(details);
      }
      if (approval.status || !jobId) {
        const label = approval.status === 'approved' ? 'Aprovado'
          : approval.status === 'rejected' ? 'Recusado'
            : 'Expirado ou cancelado';
        card.append(h('div', { class: 'omni-approval-actions' },
          h('span', { class: 'omni-approval-status', text: label }),
        ));
        body.append(card);
        return;
      }
      const actions = h('div', { class: 'omni-approval-actions' });
      const approve = h('button', { class: 'omni-approve-btn', type: 'button', text: 'Aprovar e executar' });
      const reject = h('button', { class: 'omni-reject-btn', type: 'button', text: 'Recusar' });
      const respond = async (decision: 'approve' | 'reject') => {
        approve.disabled = true;
        reject.disabled = true;
        try {
          const response = await fetch(`/api/omniroute/jobs/${jobId}/approvals/${approval.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision }),
          });
          if (!response.ok) {
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error || `Falha ao responder aprovação (HTTP ${response.status})`);
          }
          approval.status = decision === 'approve' ? 'approved' : 'rejected';
          actions.replaceChildren(h('span', { class: 'omni-approval-status', text: decision === 'approve' ? 'Aprovado' : 'Recusado' }));
          this.saveMessages();
        } catch (error) {
          if (error instanceof Error && /expirada|cancelada|não encontrada/i.test(error.message)) {
            approval.status = 'expired';
            actions.replaceChildren(h('span', { class: 'omni-approval-status', text: 'Expirado ou cancelado' }));
            this.saveMessages();
            return;
          }
          approve.disabled = false;
          reject.disabled = false;
          actions.append(h('span', { class: 'omni-approval-error', text: (error as Error).message }));
        }
      };
      approve.addEventListener('click', () => void respond('approve'));
      reject.addEventListener('click', () => void respond('reject'));
      actions.append(approve, reject);
      card.append(actions);
      body.append(card);
      this.scrollToBottom();
    }

  private appendToolResult(id: string, result: { tool: string; ok: boolean; message: string }): void {
      const body = this.messagesList.querySelector(`[data-msg-id="${id}"] .omni-msg-body`);
      if (!body) return;
      const details = h('details', { class: `omni-tool-result${result.ok ? '' : ' is-error'}` },
        h('summary', { text: `${result.ok ? '✓' : '⚠'} ${result.tool}` }),
        h('pre', { text: result.message }),
      );
      body.append(details);
      this.scrollToBottom();
  }

  private renderMessages(): void {
    this.messagesList.textContent = '';
    for (const msg of this.messages) {
      const isUser = msg.role === 'user';
      const bubble = h('article', {
        class: `omni-msg-card is-${msg.role}`,
        attrs: { 'data-msg-id': msg.id },
      });

      const meta = h('header', { class: 'omni-msg-header' });
      const avatar = h('span', { class: 'omni-msg-avatar', text: isUser ? '👤' : '🤖' });
      const roleText = h('strong', { class: 'omni-msg-role', text: isUser ? 'Você' : 'OmniRoute' });
      meta.append(avatar, roleText);

      if (msg.combo) {
        meta.append(h('span', { class: 'omni-combo-chip', text: msg.combo }));
      }
      if (msg.model) {
        meta.append(h('span', { class: 'omni-model-chip', text: msg.model }));
      }

      const body = h('div', { class: 'omni-msg-body' });
      if (msg.content) {
        body.append(renderMarkdown(msg.content));
        this.enhanceCodeBlocks(body);
      } else if (this.isStreaming && msg.role === 'assistant') {
        body.append(h('span', { class: 'omni-typing-dot', text: 'Digitando…' }));
      }

      bubble.append(meta, body);
      this.messagesList.append(bubble);
      for (const event of msg.events ?? []) {
        if (event.type === 'activity') this.appendActivity(msg.id, event.activity);
        else if (event.type === 'approval') this.appendApproval(msg.id, event.approval, msg.jobId ?? null);
        else if (event.type === 'tool_result') this.appendToolResult(msg.id, event.result);
      }
    }
    this.scrollToBottom();
  }

  private enhanceCodeBlocks(parent: HTMLElement): void {
    parent.querySelectorAll('.ui-md__block').forEach((box) => {
      if (box.querySelector('.omni-copy-code-btn')) return;
      const pre = box.querySelector('pre');
      const copyBtn = h('button', {
        class: 'omni-copy-code-btn',
        attrs: { title: 'Copiar código' },
        text: 'Copiar',
        on: {
          click: async () => {
            if (pre?.textContent) {
              await copyText(pre.textContent);
              copyBtn.textContent = 'Copiado!';
              setTimeout(() => (copyBtn.textContent = 'Copiar'), 2000);
            }
          },
        },
      });
      box.append(copyBtn);
    });
  }

  private renderActivity(): void {
    this.activityView.textContent = '';
    const snap = this.ctx.store.snapshot;
    if (!snap || !snap.agents.length) {
      this.activityView.append(
        h('div', {
          class: 'omni-empty-activity',
        }, h('p', { text: 'Nenhum agente executando no momento.' }), h('small', { text: 'Inicie uma tarefa no VS Code ou pelo terminal para ver as atividades aqui.' })),
      );
      return;
    }

    const agentsList = h('div', { class: 'omni-activity-agents' });
    for (const a of snap.agents) {
      const card = h('div', { class: 'omni-agent-card' });
      const top = h('div', { class: 'omni-agent-top' });
      top.append(
        h('strong', { text: a.name }),
        h('span', { class: `omni-status-tag is-${a.status}`, text: a.status }),
        h('span', { class: 'omni-role-tag', text: a.role }),
      );
      card.append(top);

      if (a.activity?.text) {
        card.append(
          h('div', {
            class: 'omni-agent-act',
          }, h('span', { class: 'omni-act-icon', text: a.activity.icon || '⚙️' }), h('span', { text: a.activity.text })),
        );
      }

      if (a.recent && a.recent.length) {
        const recentBox = h('ul', { class: 'omni-agent-recent' });
        for (const r of a.recent.slice(-4)) {
          recentBox.append(
            h('li', {
            }, h('span', { class: 'omni-recent-icon', text: r.icon || '✓' }), h('span', { text: r.text })),
          );
        }
        card.append(recentBox);
      }
      agentsList.append(card);
    }
    this.activityView.append(agentsList);
  }

  private scrollToBottom(): void {
    this.messagesList.scrollTop = this.messagesList.scrollHeight;
  }

  private loadStoredMessages(): ChatMsg[] {
    try {
      const raw = localStorage.getItem('habblaud_omnichat_history');
      if (raw) return JSON.parse(raw) as ChatMsg[];
    } catch {
      // Ignora erro de JSON
    }
    return [];
  }

  private saveMessages(): void {
    try {
      const messages = this.messages.slice(-50).map((message) => ({
        ...message,
        jobId: undefined,
        events: message.events?.slice(-20).map((event) => {
          if (event.type === 'activity') return { ...event, activity: event.activity.slice(0, 1000) };
          if (event.type === 'tool_result') return { ...event, result: { ...event.result, message: event.result.message.slice(0, 4000) } };
          return {
            ...event,
            approval: {
              id: event.approval.id,
              kind: event.approval.kind,
              summary: event.approval.summary,
              ...(event.approval.path ? { path: event.approval.path } : {}),
              ...(event.approval.check ? { check: event.approval.check } : {}),
              ...(event.approval.status ? { status: event.approval.status } : {}),
            },
          };
        }),
      }));
      localStorage.setItem('habblaud_omnichat_history', JSON.stringify(messages));
    } catch {
      // Ignora erro de cota
    }
  }

  render(): void {
    if (this.currentTab === 'activity') {
      this.renderActivity();
    }
  }
}
