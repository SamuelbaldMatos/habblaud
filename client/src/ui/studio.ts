// Estúdio de código: conversas persistentes, tarefas reanexáveis, aprovações e decisões explícitas.
import type { UiComponent, UiContext } from './context';
import { h, setAttr, setHidden, setText } from './dom';
import { renderMarkdown } from './markdown';
import { parseOmniRouteStreamEvent, type OmniRouteApproval } from './chat-stream';
import { loadVoiceConfig, saveVoiceConfig, speechText, VoiceClient, VoicePlayer, VoiceRecorder, type VoiceConfig } from './studio-voice';
import './studio.css';

type Json = Record<string, unknown>;
type Tab = 'tasks' | 'chat' | 'usage';
type Manager = 'orquestrador' | 'gerente-jarvis';

interface StudioDecision {
  id: string;
  question: string;
  options: string[];
  recommended?: number;
  status: 'pending' | 'answered' | 'expired';
  choice?: number;
  note?: string;
}

type StudioStreamEvent =
  | ReturnType<typeof parseOmniRouteStreamEvent>
  | { type: 'decision'; seq?: number; decision: StudioDecision };

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  jobId?: string;
  error?: boolean;
  approval?: OmniRouteApproval;
  decision?: StudioDecision;
  result?: { tool: string; ok: boolean; message: string };
}

interface Conversation {
  version: 1;
  threadId: string;
  jobId: string | null;
  seq: number;
  active: boolean;
  workspace: string;
  model: string;
  manager: Manager;
  messages: Message[];
  activities: string[];
}

interface MessageView {
  el: HTMLElement;
  body: HTMLElement;
  content: string;
  approvalStatus: string;
  decisionStatus: string;
}

const PREFIX = 'habblaud_studio_v1:';
const API = '/api/omniroute';
const BACKOFF = [1000, 2000, 5000];

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Json
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return 'Não informado';
  return JSON.stringify(value, null, 2) ?? 'Não informado';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha ao comunicar com o OmniRoute.';
}

function uid(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function dateLabel(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'Não informado';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Não informado' : date.toLocaleString('pt-BR');
}

function metric(value: unknown, suffix = ''): string {
  const number = num(value);
  return number === undefined ? '—' : `${number.toLocaleString('pt-BR')}${suffix}`;
}

function action(label: string, click: () => void): HTMLButtonElement {
  return h('button', { type: 'button', text: label, on: { click } });
}

function parseDecision(value: unknown): StudioDecision {
  const data = obj(value);
  const options = list(data.options);
  if (
    !str(data.id) || typeof data.question !== 'string' ||
    !options.length || !options.every((option): option is string => typeof option === 'string')
  ) {
    throw new Error('Evento de decisão inválido.');
  }

  const decision: StudioDecision = {
    id: str(data.id),
    question: data.question,
    options: [...options],
    status: 'pending',
  };
  const recommended = num(data.recommended);
  if (
    recommended !== undefined && Number.isInteger(recommended) &&
    recommended >= 0 && recommended < options.length
  ) {
    decision.recommended = recommended;
  }
  return decision;
}

/** Intercepta decisões localmente; os demais eventos mantêm o parser compartilhado. */
function parseStudioStreamEvent(payload: string, envelope: Json): StudioStreamEvent {
  if (envelope.type !== 'decision') return parseOmniRouteStreamEvent(payload);
  const event: StudioStreamEvent = {
    type: 'decision',
    decision: parseDecision(envelope.decision),
  };
  const seq = num(envelope.seq);
  if (seq !== undefined) event.seq = seq;
  return event;
}

function freshConversation(threadId = uid()): Conversation {
  return {
    version: 1,
    threadId,
    jobId: null,
    seq: -1,
    active: false,
    workspace: '',
    model: '',
    manager: 'orquestrador',
    messages: [],
    activities: [],
  };
}

function stored(key: string): unknown {
  try {
    const value = localStorage.getItem(PREFIX + key);
    return value === null ? undefined : JSON.parse(value) as unknown;
  } catch {
    // Armazenamento bloqueado ou conteúdo inválido não impede abrir o estúdio.
    return undefined;
  }
}

/** `raw` vem do armazenamento local ou do histórico no servidor; os dois passam pela mesma validação. */
function loadConversation(threadId: string, raw: unknown = stored(`thread:${threadId}`)): Conversation {
  const data = obj(raw);
  const state = freshConversation(threadId);
  if (data.version !== 1 || data.threadId !== threadId) return state;

  state.jobId = str(data.jobId) || null;
  state.seq = Math.max(-1, Math.floor(num(data.seq) ?? -1));
  state.active = data.active === true && state.jobId !== null;
  state.workspace = str(data.workspace);
  state.model = str(data.model);
  state.manager = data.manager === 'gerente-jarvis' ? 'gerente-jarvis' : 'orquestrador';
  state.activities = list(data.activities).filter((v): v is string => typeof v === 'string').slice(-100);

  const ids = new Set<string>();
  for (const raw of list(data.messages).slice(-200)) {
    const item = obj(raw);
    if (
      typeof item.id !== 'string' || ids.has(item.id) ||
      !['user', 'assistant', 'system'].includes(str(item.role)) ||
      typeof item.content !== 'string'
    ) continue;

    const message: Message = {
      id: item.id,
      role: item.role as Message['role'],
      content: item.content,
    };
    ids.add(message.id);
    if (typeof item.jobId === 'string') message.jobId = item.jobId;
    if (item.error === true) message.error = true;

    // Reutiliza a validação dos eventos também para os dados persistidos.
    try {
      if (item.approval) {
        const event = parseOmniRouteStreamEvent(JSON.stringify({
          type: 'approval', approval: item.approval,
        }));
        if (event.type === 'approval') {
          message.approval = event.approval;
          const status = obj(item.approval).status;
          if (status === 'approved' || status === 'rejected' || status === 'expired') {
            message.approval.status = status;
          }
        }
      }
      if (item.result) {
        const event = parseOmniRouteStreamEvent(JSON.stringify({
          type: 'tool_result', result: item.result,
        }));
        if (event.type === 'tool_result') message.result = event.result;
      }
    } catch {
      // Descarta apenas os detalhes inválidos da mensagem.
    }

    try {
      if (item.decision) {
        const decision = parseDecision(item.decision);
        const saved = obj(item.decision);
        const choice = num(saved.choice);
        if (
          saved.status === 'answered' && choice !== undefined &&
          Number.isInteger(choice) && choice >= 0 && choice < decision.options.length
        ) {
          decision.status = 'answered';
          decision.choice = choice;
        } else if (saved.status === 'expired') {
          decision.status = 'expired';
        }
        if (typeof saved.note === 'string') decision.note = saved.note.slice(0, 500);
        message.decision = decision;
      }
    } catch {
      // Uma decisão inválida não elimina os outros detalhes da mensagem.
    }
    state.messages.push(message);
  }
  return state;
}

/** LCS limitado pelo total de linhas; arquivos maiores usam comparação lado a lado. */
function diffView(before: string, after: string): HTMLElement {
  const left = before === '' ? [] : before.split('\n');
  const right = after === '' ? [] : after.split('\n');
  if (left.length + right.length > 2000) {
    return h('div', { class: 'studio-versions' },
      h('section', {}, h('strong', { text: 'Antes' }), h('pre', { text: before })),
      h('section', {}, h('strong', { text: 'Depois' }), h('pre', { text: after })),
    );
  }

  const width = right.length + 1;
  const table = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j]
        ? 1 + (table[(i + 1) * width + j + 1] ?? 0)
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  const pre = h('pre', { class: 'studio-diff', attrs: { 'aria-label': 'Diferenças de linhas' } });
  let i = 0;
  let j = 0;
  const line = (kind: string, prefix: string, text: string): void => {
    pre.append(h('span', { class: kind, text: `${prefix}${text}\n` }));
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      line('', '  ', left[i] ?? '');
      i++;
      j++;
    } else if (
      j < right.length &&
      (i >= left.length || (table[i * width + j + 1] ?? 0) > (table[(i + 1) * width + j] ?? 0))
    ) {
      line('studio-added', '+ ', right[j] ?? '');
      j++;
    } else {
      line('studio-removed', '- ', left[i] ?? '');
      i++;
    }
  }
  if (!left.length && !right.length) pre.textContent = 'Nenhuma alteração de conteúdo.';
  return pre;
}

export class StudioPanel implements UiComponent {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;

  private opened = false;
  private state: Conversation;
  private tab: Tab = 'chat';
  private previousFocus: HTMLElement | null = null;
  private readonly inertSiblings = new Map<HTMLElement, string | null>();

  private readonly workspace = h('select', { attrs: { 'aria-label': 'Workspace' } });
  private readonly jobs = h('div', { class: 'studio-jobs' });
  /** Conversas guardadas no servidor: o histórico vale em qualquer navegador. */
  private readonly threads = h('div', { class: 'studio-jobs studio-threads' });
  private readonly threadSaves = new Map<string, number>();
  private readonly alerts = h('div', { class: 'studio-alerts', attrs: { 'aria-live': 'polite' } });
  private readonly usage = h('div', { class: 'studio-usage' });
  private readonly project = h('div', { class: 'studio-project' });
  private readonly timeline = h('div', {
    class: 'studio-timeline', tabIndex: 0, attrs: { 'aria-label': 'Mensagens da conversa' },
  });
  private readonly heading = h('h1', { text: 'Estúdio de código' });
  private readonly model = h('span', { class: 'studio-muted' });
  private readonly manager = h('select', { attrs: { 'aria-label': 'Gerente' } },
    h('option', { text: 'Orquestrador (nuvem)', attrs: { value: 'orquestrador' } }),
    h('option', { text: 'Jarvis (local)', attrs: { value: 'gerente-jarvis' } }),
  );
  private readonly connection = h('span', { class: 'studio-muted', role: 'status' });
  private readonly storageWarning = h('p', { class: 'studio-error', hidden: true, role: 'status' });
  private readonly activitySummary = h('summary', { text: 'Atividade' });
  private readonly activityList = h('ol', { class: 'studio-activity-list' });
  private readonly input = h('textarea', {
    attrs: {
      rows: 3,
      'aria-label': 'Instrução para o agente',
      placeholder: 'O que vamos programar? Ctrl+Enter envia.',
    },
  });
  /** Receitas (roteiros do vibe-coding-toolkit adaptados): escolher uma preenche o pedido com o roteiro. */
  private readonly recipe = h('select', { class: 'studio-recipe', attrs: { 'aria-label': 'Receitas de trabalho' } },
    h('option', { text: 'Receitas…', attrs: { value: '' } }));
  private recipes: Array<{ id: string; titulo: string; resumo: string; modo: string; corpo: string }> = [];
  private readonly send = action('Enviar', () => void this.sendMessage());
  /** Voz do Jarvis pelo VoiceStudio local (127.0.0.1:3900): microfone vira pedido; resposta final é falada. */
  private voiceCfg: VoiceConfig = loadVoiceConfig(typeof localStorage === 'undefined' ? undefined : localStorage);
  private readonly voice = new VoiceClient(() => this.voiceCfg);
  private readonly recorder = new VoiceRecorder();
  private readonly player = new VoicePlayer();
  private voiceBusy = false;
  private readonly mic = action('🎤 Falar', () => void this.toggleMic());
  private readonly speakToggle = action('', () => this.toggleSpeak());
  private readonly stop = action('Parar', () => void this.cancelJob());
  private readonly refreshCard = action('Atualizar cartão', () => void this.loadProject(true));
  private readonly newChat = action('Nova conversa', () => this.newConversation());
  private readonly columns: Record<Tab, HTMLElement>;
  private readonly tabs: Record<Tab, HTMLButtonElement>;
  private readonly views = new Map<string, MessageView>();
  private readonly respondingDecisions = new WeakSet<StudioDecision>();

  private transport: AbortController | null = null;
  private polling: AbortController | null = null;
  private projectRequest: AbortController | null = null;
  private jobsTimer: number | undefined;
  private statusTimer: number | undefined;
  private jobsBusy = false;
  private statusBusy = false;
  private cancelling = false;

  constructor(private readonly ctx: UiContext) {
    const current = stored('current');
    this.state = typeof current === 'string' ? loadConversation(current) : freshConversation();

    this.button = h('button', {
      class: 'ui-icon-btn studio-launch',
      type: 'button',
      text: '⌨ Estúdio',
      title: 'Estúdio de código (C) · Jarvis (J)',
      attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      on: { click: () => this.toggle() },
    });

    this.tabs = {
      tasks: action('Tarefas', () => this.selectTab('tasks')),
      chat: action('Conversa', () => this.selectTab('chat')),
      usage: action('Uso e projeto', () => this.selectTab('usage')),
    };
    const nav = h('nav', { class: 'studio-tabs', attrs: { 'aria-label': 'Áreas do estúdio' } },
      this.tabs.tasks, this.tabs.chat, this.tabs.usage,
    );

    this.columns = {
      tasks: h('aside', { class: 'studio-column studio-left', attrs: { 'aria-label': 'Workspaces e tarefas' } },
        h('h2', { text: 'Workspaces' }),
        this.workspace,
        this.newChat,
        h('h2', { text: 'Conversas' }),
        this.threads,
        h('h2', { text: 'Tarefas' }),
        this.jobs,
        h('h2', { text: 'Alertas OmniRoute' }),
        this.alerts,
      ),
      chat: h('section', { class: 'studio-column studio-center', attrs: { 'aria-label': 'Conversa' } },
        h('div', { class: 'studio-conversation-meta' },
          this.model,
          h('label', { class: 'studio-manager' },
            h('span', { text: 'Gerente' }), this.manager,
          ),
          this.connection,
        ),
        this.storageWarning,
        this.timeline,
        h('details', { class: 'studio-activity' }, this.activitySummary, this.activityList),
        h('div', { class: 'studio-composer' },
          this.input,
          h('div', { class: 'studio-actions' },
            this.recipe,
            h('small', { class: 'studio-muted', text: 'Ctrl+Enter envia · Esc fecha sem cancelar' }),
            this.mic, this.speakToggle, this.send, this.stop,
          ),
        ),
      ),
      usage: h('aside', { class: 'studio-column studio-right', attrs: { 'aria-label': 'Uso e projeto' } },
        h('h2', { text: 'Uso e roteamento' }), this.usage,
        h('h2', { text: 'Cartão do projeto' }), this.refreshCard, this.project,
      ),
    };

    this.el = h('section', {
      class: 'studio-overlay',
      hidden: true,
      role: 'dialog',
      tabIndex: -1,
      attrs: { 'aria-modal': 'true', 'aria-label': 'Estúdio de código' },
    },
    h('header', { class: 'studio-header' },
      this.heading,
      action('Fechar · Esc', () => this.toggle(false)),
    ),
    nav,
    h('div', { class: 'studio-layout' }, this.columns.tasks, this.columns.chat, this.columns.usage));

    this.workspace.addEventListener('change', () => {
      this.state.workspace = this.workspace.value;
      this.save();
      void this.loadProject();
    });
    this.manager.addEventListener('change', () => {
      if (!this.state.active) {
        this.state.manager = this.manager.value === 'gerente-jarvis' ? 'gerente-jarvis' : 'orquestrador';
        this.save();
      }
      this.render();
    });
    this.recipe.addEventListener('change', () => this.applyRecipe());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    // Não deixa atalhos do escritório receberem teclas usadas dentro do estúdio.
    this.el.addEventListener('keydown', (event) => event.stopPropagation());
    this.el.addEventListener('keyup', (event) => event.stopPropagation());
    window.addEventListener('keydown', (event) => this.handleKey(event), true);

    this.selectTab('chat');
    this.syncWorkspace();
    this.syncMessages();
    this.syncActivities();
    this.render();
    this.save();

    // Retoma também quando o overlay está fechado; fechar nunca cancela a tarefa.
    if (this.state.active && this.state.jobId) this.startTransport();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  openJarvis(): void {
    // A seleção vale para o próximo POST; não cancela nem reinicia uma tarefa já enviada.
    this.state.manager = 'gerente-jarvis';
    this.save();
    this.render();
    this.toggle(true);
    this.selectTab('chat');
    this.input.focus();
  }

  toggle(open?: boolean): void {
    const next = open ?? !this.opened;
    if (next === this.opened) return;
    this.opened = next;
    setHidden(this.el, !next);
    setAttr(this.button, 'aria-expanded', String(next));
    this.button.classList.toggle('is-active', next);

    if (next) {
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      for (const child of Array.from(this.ctx.root.children)) {
        if (!(child instanceof HTMLElement) || child === this.el || child.contains(this.el)) continue;
        this.inertSiblings.set(child, child.getAttribute('inert'));
        child.setAttribute('inert', '');
      }
      this.startPolling();
      void this.loadThreads();
      void this.checkVoice();
      this.el.focus();
      this.ctx.announce('Estúdio de código aberto.');
    } else {
      this.stopPolling();
      for (const [element, previous] of this.inertSiblings) {
        setAttr(element, 'inert', previous);
      }
      this.inertSiblings.clear();
      if (this.previousFocus?.isConnected) this.previousFocus.focus();
      else this.button.focus();
    }
    this.ctx.invalidate();
  }

  render(): void {
    const active = this.state.active;
    this.send.disabled = active || !this.state.workspace;
    this.workspace.disabled = active;
    this.manager.disabled = active;
    this.syncVoice();
    this.manager.value = this.state.manager;
    this.newChat.disabled = active && !this.state.jobId;
    this.stop.disabled = !active || !this.state.jobId || this.cancelling;
    setHidden(this.stop, !active);
    setText(this.model, `Modelo: ${this.state.model || 'aguardando seleção do roteador'}`);
    const title = this.state.manager === 'gerente-jarvis'
      ? 'Jarvis · Estúdio de código' : 'Estúdio de código';
    setText(this.heading, title);
    setAttr(this.el, 'aria-label', title);
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (this.opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggle(false);
      return;
    }
    const target = event.composedPath()[0];
    const editable = target instanceof HTMLElement &&
      (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable]')));
    // C (de código) e J (de Jarvis): o E é "entrar" na cidade do Habblaud World.
    const key = event.key.toLowerCase();
    if (
      !editable && !event.repeat && (key === 'c' || key === 'j') &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === 'j') this.openJarvis();
      else this.toggle();
      return;
    }
    if (!this.opened || event.key !== 'Tab') return;

    const focusable = Array.from(this.el.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      this.el.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === this.el)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !this.el.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  private selectTab(tab: Tab): void {
    this.tab = tab;
    for (const key of ['tasks', 'chat', 'usage'] as const) {
      this.columns[key].classList.toggle('is-selected', key === this.tab);
      this.tabs[key].classList.toggle('is-active', key === this.tab);
      setAttr(this.tabs[key], 'aria-pressed', String(key === this.tab));
    }
  }

  private save(state = this.state): void {
    state.messages = state.messages.slice(-200);
    state.activities = state.activities.slice(-100);
    try {
      // Mensagens e cursor são gravados juntos: nunca avança seq sem guardar o texto correspondente.
      localStorage.setItem(PREFIX + `thread:${state.threadId}`, JSON.stringify(state));
      if (state.jobId) {
        localStorage.setItem(PREFIX + `job:${state.jobId}`, JSON.stringify(state.threadId));
      }
      if (state === this.state) localStorage.setItem(PREFIX + 'current', JSON.stringify(state.threadId));
      setHidden(this.storageWarning, true);
    } catch {
      setText(this.storageWarning, 'Não foi possível salvar localmente. A continuidade após recarregar pode ser perdida.');
      setHidden(this.storageWarning, false);
    }
    this.saveRemote(state);
  }

  /** Grava a conversa no servidor, agrupando as mudanças de um segundo e meio numa só requisição. */
  private saveRemote(state: Conversation): void {
    if (!state.messages.some((m) => m.role === 'user')) return;
    const id = state.threadId;
    window.clearTimeout(this.threadSaves.get(id));
    this.threadSaves.set(id, window.setTimeout(() => {
      this.threadSaves.delete(id);
      const first = state.messages.find((m) => m.role === 'user');
      const body = {
        title: (first?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Conversa ${id.slice(0, 8)}`,
        workspace: state.workspace,
        manager: state.manager,
        updatedAt: new Date().toISOString(),
        messages: state.messages,
      };
      fetch(`${API}/threads/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then((response) => { if (response.ok && this.opened) void this.loadThreads(); })
        // Sem servidor de histórico a conversa continua no armazenamento local.
        .catch(() => undefined);
    }, 1500));
  }

  private syncVoice(): void {
    setText(this.speakToggle, this.voiceCfg.speak ? '🔊 Voz ligada' : '🔇 Voz desligada');
    setAttr(this.speakToggle, 'aria-pressed', String(this.voiceCfg.speak));
    this.speakToggle.title = 'Falar as respostas do Jarvis (VoiceStudio local)';
    setText(this.mic, this.recorder.recording ? '■ Parar e enviar' : this.voiceBusy ? 'Transcrevendo…' : '🎤 Falar');
    this.mic.classList.toggle('is-active', this.recorder.recording);
    this.mic.disabled = this.voiceBusy || (!this.recorder.recording && this.state.active);
  }

  private async checkVoice(): Promise<void> {
    const ok = VoiceRecorder.supported() && await this.voice.available();
    setHidden(this.mic, !ok);
    setHidden(this.speakToggle, !ok);
    this.syncVoice();
  }

  private toggleSpeak(): void {
    this.voiceCfg = { ...this.voiceCfg, speak: !this.voiceCfg.speak };
    saveVoiceConfig(typeof localStorage === 'undefined' ? undefined : localStorage, this.voiceCfg);
    if (!this.voiceCfg.speak) this.player.stop();
    this.syncVoice();
  }

  private async toggleMic(): Promise<void> {
    if (this.voiceBusy) return;
    try {
      if (!this.recorder.recording) {
        this.player.stop();
        await this.recorder.start();
        this.ctx.announce('Gravando. Clique de novo para enviar.');
        this.syncVoice();
        return;
      }
      this.voiceBusy = true;
      this.syncVoice();
      const text = await this.voice.transcribe(await this.recorder.stop());
      if (!text) { this.report('Não entendi o áudio; tente de novo.'); return; }
      this.input.value = this.input.value.trim() ? `${this.input.value.trim()}\n${text}` : text;
      await this.sendMessage();
    } catch (error) {
      this.recorder.cancel();
      this.report(`Voz: ${errorText(error)}`);
    } finally {
      this.voiceBusy = false;
      this.syncVoice();
    }
  }

  private speakLastReply(): void {
    if (!this.voiceCfg.speak) return;
    const last = [...this.state.messages].reverse().find((m) => m.role === 'assistant' && m.jobId === (this.state.jobId ?? undefined));
    const text = last ? speechText(last.content) : '';
    if (!text) return;
    this.voice.synthesize(text)
      .then((audio) => this.player.play(audio))
      .catch((error: unknown) => this.report(`Voz: ${errorText(error)}`));
  }

  private async loadThreads(): Promise<void> {
    try {
      const data = await this.getJson(`${API}/threads`, AbortSignal.timeout(10_000));
      const items = list(data.threads).map(obj).filter((t) => str(t.id)).slice(0, 30);
      this.threads.replaceChildren(...items.map((t) => {
        const id = str(t.id);
        const button = action([str(t.title, id), `${str(t.workspace, '—')} · ${dateLabel(t.updatedAt)}`].join('\n'), () => void this.openThread(id));
        button.className = `studio-job${id === this.state.threadId ? ' is-active' : ''}`;
        return button;
      }));
      if (!items.length) this.threads.append(h('p', { class: 'studio-muted', text: 'Nenhuma conversa guardada ainda.' }));
    } catch {
      this.threads.replaceChildren(h('p', { class: 'studio-muted', text: 'Histórico no servidor indisponível; as conversas ficam neste navegador.' }));
    }
  }

  private async openThread(id: string): Promise<void> {
    if (id === this.state.threadId || (this.state.active && !this.state.jobId)) return;
    // A cópia local guarda também a tarefa e o cursor; sem ela, usa o histórico do servidor.
    let state = loadConversation(id);
    if (!state.messages.length) {
      try {
        const doc = await this.getJson(`${API}/threads/${encodeURIComponent(id)}`, AbortSignal.timeout(10_000));
        state = loadConversation(id, { ...doc, version: 1, threadId: id, jobId: null, seq: -1, active: false, activities: [] });
      } catch (error) {
        this.report(errorText(error));
        return;
      }
    }
    this.switchConversation(state);
    this.selectTab('chat');
    void this.loadThreads();
    if (this.opened) void this.loadProject();
  }

  private addMessage(message: Message): void {
    this.state.messages.push(message);
    this.state.messages = this.state.messages.slice(-200);
  }

  private report(text: string): void {
    this.addMessage({ id: uid(), role: 'system', content: text, error: true });
    this.save();
    this.syncMessages();
  }

  private newConversation(): void {
    if (this.state.active && !this.state.jobId) return;
    const workspace = this.state.workspace;
    const manager = this.state.manager;
    this.switchConversation(freshConversation());
    this.state.workspace = workspace;
    this.state.manager = manager;
    this.syncWorkspace();
    this.save();
    this.render();
    this.selectTab('chat');
    this.input.focus();
    if (this.opened) void this.loadProject();
  }

  private switchConversation(state: Conversation): void {
    this.save();
    this.transport?.abort();
    this.transport = null;
    this.projectRequest?.abort();
    this.cancelling = false;
    this.state = state;
    this.views.clear();
    this.timeline.replaceChildren();
    this.input.value = '';
    setText(this.connection, state.active ? 'Reconectando…' : 'Pronto');
    this.syncWorkspace();
    this.syncMessages();
    this.syncActivities();
    this.render();
    this.save();
  }

  private attachJob(job: Json): void {
    const jobId = str(job.id);
    if (!jobId || (this.state.active && !this.state.jobId)) return;
    if (jobId === this.state.jobId && this.transport) {
      this.selectTab('chat');
      return;
    }

    const mapped = stored(`job:${jobId}`);
    const threadId = typeof mapped === 'string' ? mapped : `job-${jobId}`;
    const state = loadConversation(threadId);
    if (state.jobId !== jobId) {
      // Uma conversa pode ter várias tarefas. Ao voltar a uma antiga, o replay começa em zero.
      state.jobId = jobId;
      state.seq = -1;
      state.messages = state.messages.filter((message) => message.jobId !== jobId);
      state.model = '';
      state.activities = [];
    }
    state.workspace = str(job.workspace, state.workspace);
    state.active = true;
    this.switchConversation(state);
    this.selectTab('chat');
    this.startTransport();
    if (this.opened) void this.loadProject();
  }

  private async sendMessage(): Promise<void> {
    const message = this.input.value.trim();
    if (!message || this.state.active || !this.state.workspace) return;

    const history = this.state.messages
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .slice(-10)
      .map((item) => ({ role: item.role, content: item.content }));

    this.state.jobId = null;
    this.state.seq = -1;
    this.state.active = true;
    this.state.model = '';
    this.state.activities = [];
    this.addMessage({ id: uid(), role: 'user', content: message });
    this.input.value = '';
    this.syncMessages();
    this.syncActivities();
    this.render();
    this.save();
    this.startTransport({
      message,
      messages: history,
      workspace: this.state.workspace,
      threadId: this.state.threadId,
      manager: this.state.manager,
    });
  }

  private startTransport(body?: Json): void {
    this.transport?.abort();
    const controller = new AbortController();
    this.transport = controller;
    void this.transportLoop(controller, body);
  }

  private async transportLoop(controller: AbortController, body?: Json): Promise<void> {
    const signal = controller.signal;
    let initialBody = body;
    let failures = 0;

    try {
      while (!signal.aborted && this.state.active) {
        let received = false;
        try {
          const starting = initialBody !== undefined;
          const requestBody = initialBody;
          initialBody = undefined;
          const jobId = this.state.jobId;
          if (!starting && !jobId) throw new Error('Tarefa sem identificador para reconexão.');

          setText(this.connection, starting ? 'Iniciando tarefa…' : 'Conectando à tarefa…');
          const response = await fetch(starting
            ? `${API}/run`
            : `${API}/jobs/${encodeURIComponent(jobId ?? '')}/stream?after=${this.state.seq}`, {
            method: starting ? 'POST' : 'GET',
            headers: starting
              ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
              : { Accept: 'text/event-stream' },
            ...(starting ? { body: JSON.stringify(requestBody) } : {}),
            cache: 'no-store',
            signal,
          });
          if (signal.aborted || this.transport !== controller) return;
          if (!starting && response.status === 404) {
            this.finish('Tarefa não encontrada ou já removida do servidor.');
            this.report('O servidor não possui mais esta tarefa. O histórico local foi preservado.');
            return;
          }
          if (!response.ok) throw new Error(`Falha no stream (HTTP ${response.status}).`);
          if (!response.body) throw new Error('O servidor retornou um stream vazio.');

          setText(this.connection, 'Conectado');
          await this.readStream(response.body, signal, (payload) => {
            if (signal.aborted || this.transport !== controller) return;
            const applied = this.applyEvent(payload);
            received = received || applied;
          });
          if (signal.aborted || !this.state.active) return;
          throw new Error('A conexão foi interrompida antes da conclusão.');
        } catch (error) {
          if (signal.aborted || this.transport !== controller) return;
          if (!this.state.jobId) {
            this.finish('Conexão encerrada sem identificador de tarefa.');
            this.report(`${errorText(error)} A tarefa pode ter sido criada. Confira a lista antes de reenviar; o POST não será repetido automaticamente.`);
            return;
          }
          if (received) failures = 0;
          const delay = BACKOFF[Math.min(failures++, BACKOFF.length - 1)] ?? 5000;
          setText(this.connection, `Conexão perdida · nova tentativa em ${delay / 1000}s`);
          await this.wait(delay, signal);
        }
      }
    } finally {
      if (this.transport === controller) {
        this.transport = null;
        this.render();
      }
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  /** Aceita fragmentação arbitrária, CRLF, comentários e múltiplas linhas data por evento. */
  private async readStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    consume: (payload: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];

    const line = (value: string): void => {
      if (value === '') {
        if (data.length) consume(data.join('\n'));
        data = [];
      } else if (value.startsWith('data:')) {
        const content = value.slice(5);
        data.push(content.startsWith(' ') ? content.slice(1) : content);
      }
    };

    try {
      while (!signal.aborted && this.state.active) {
        const chunk = await reader.read();
        if (signal.aborted) return;
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          line(buffer.slice(0, newline).replace(/\r$/, ''));
          buffer = buffer.slice(newline + 1);
          if (!this.state.active) return;
          newline = buffer.indexOf('\n');
        }
        if (chunk.done) {
          // Um evento sem delimitador final fica para o replay, sem avançar o cursor.
          return;
        }
        if (buffer.length > 8 * 1024 * 1024) {
          throw new Error('Evento do stream excedeu o limite de segurança.');
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // O fetch pode já ter encerrado o leitor após um abort.
      }
      reader.releaseLock();
    }
  }

  private applyEvent(payload: string): boolean {
    let envelope: Json = {};
    if (payload !== '[DONE]') envelope = obj(JSON.parse(payload) as unknown);
    const seq = num(envelope.seq);
    const eventJob = str(envelope.jobId);
    if (eventJob && this.state.jobId && eventJob !== this.state.jobId) return false;
    if (seq !== undefined && seq <= this.state.seq) return false;

    const event = parseStudioStreamEvent(payload, envelope);
    if (eventJob && !this.state.jobId) this.assignJob(eventJob);

    if (event.type === 'job') {
      this.assignJob(event.jobId);
    } else if (event.type === 'data') {
      if (event.model) this.state.model = event.model;
      if (event.text) {
        let last = this.state.messages[this.state.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.jobId !== (this.state.jobId ?? undefined)) {
          last = { id: uid(), role: 'assistant', content: '' };
          if (this.state.jobId) last.jobId = this.state.jobId;
          this.addMessage(last);
        }
        last.content += event.text;
      }
    } else if (event.type === 'activity') {
      this.state.activities.push(event.activity);
      this.state.activities = this.state.activities.slice(-100);
      this.syncActivities();
    } else if (event.type === 'approval') {
      const existing = this.state.messages.find((message) =>
        message.jobId === this.state.jobId && message.approval?.id === event.approval.id);
      if (!existing) {
        const message: Message = {
          id: uid(), role: 'system', content: '', approval: event.approval,
        };
        if (this.state.jobId) message.jobId = this.state.jobId;
        this.addMessage(message);
      }
    } else if (event.type === 'decision') {
      const existing = this.state.messages.find((message) =>
        message.jobId === (this.state.jobId ?? undefined) && message.decision?.id === event.decision.id);
      if (!existing) {
        const message: Message = {
          id: uid(), role: 'system', content: '', decision: event.decision,
        };
        if (this.state.jobId) message.jobId = this.state.jobId;
        this.addMessage(message);
      }
    } else if (event.type === 'tool_result') {
      const message: Message = { id: uid(), role: 'system', content: '', result: event.result };
      if (this.state.jobId) message.jobId = this.state.jobId;
      this.addMessage(message);
    } else if (event.type === 'error') {
      const message: Message = { id: uid(), role: 'system', content: event.error, error: true };
      if (this.state.jobId) message.jobId = this.state.jobId;
      this.addMessage(message);
    }
    if (seq !== undefined) this.state.seq = Math.floor(seq);
    if (event.type === 'done') this.finish('Tarefa concluída');
    else {
      this.save();
      this.syncMessages();
      this.render();
    }
    return true;
  }

  private assignJob(jobId: string): void {
    this.state.jobId = jobId;
    // O POST cria a mensagem do usuário antes de receber o identificador.
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const message = this.state.messages[i];
      if (!message || message.jobId) break;
      message.jobId = jobId;
      if (message.role === 'user') break;
    }
  }

  private finish(label: string): void {
    if (label === 'Tarefa concluída') this.speakLastReply();
    this.state.active = false;
    this.cancelling = false;
    for (const message of this.state.messages) {
      if (message.jobId === this.state.jobId && message.approval && !message.approval.status) {
        message.approval.status = 'expired';
      }
      if (message.jobId === this.state.jobId && message.decision?.status === 'pending') {
        message.decision.status = 'expired';
      }
    }
    setText(this.connection, label);
    this.save();
    this.syncMessages();
    this.render();
  }

  private async cancelJob(): Promise<void> {
    const state = this.state;
    if (!state.active || !state.jobId || this.cancelling) return;
    this.cancelling = true;
    this.render();
    try {
      const response = await fetch(`${API}/jobs/${encodeURIComponent(state.jobId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Não foi possível parar a tarefa (HTTP ${response.status}).`);
      }
      if (this.state !== state) return;
      this.transport?.abort();
      this.transport = null;
      this.finish('Tarefa interrompida');
    } catch (error) {
      if (this.state === state) this.report(errorText(error));
    } finally {
      if (this.state === state) {
        this.cancelling = false;
        this.render();
      }
    }
  }

  private syncActivities(): void {
    const last = this.state.activities[this.state.activities.length - 1];
    setText(this.activitySummary, last ? `Atividade · ${last}` : 'Atividade · aguardando');
    this.activityList.replaceChildren(...this.state.activities.map((text) => h('li', { text })));
  }

  private syncMessages(): void {
    const nearBottom = this.timeline.scrollHeight - this.timeline.scrollTop - this.timeline.clientHeight < 90;
    const wanted = new Set(this.state.messages.map((message) => message.id));
    for (const [id, view] of this.views) {
      if (!wanted.has(id)) {
        view.el.remove();
        this.views.delete(id);
      }
    }

    for (const message of this.state.messages) {
      let view = this.views.get(message.id);
      if (!view) {
        const body = h('div', { class: 'studio-message-body' });
        const el = h('article', {
          class: `studio-message is-${message.role}${message.error ? ' studio-error' : ''}`,
        },
        h('strong', { class: 'studio-message-role', text: message.role === 'user' ? 'Você' : message.role === 'assistant' ? 'Agente' : 'OmniRoute' }),
        body);
        view = { el, body, content: '\0', approvalStatus: '\0', decisionStatus: '\0' };
        this.views.set(message.id, view);
        this.timeline.append(el);
      }

      if (message.approval) {
        const status = message.approval.status ?? 'pending';
        if (view.approvalStatus !== status) {
          view.body.replaceChildren(this.approvalCard(message));
          view.approvalStatus = status;
        }
      } else if (message.decision) {
        // Não reconstrói o cartão a cada token: preserva foco e observação em edição.
        const status = JSON.stringify([
          message.decision.status, message.decision.choice, message.jobId,
        ]);
        if (view.decisionStatus !== status) {
          view.body.replaceChildren(this.decisionCard(message));
          view.decisionStatus = status;
        }
      } else if (message.result) {
        if (view.content === '\0') {
          const result = message.result;
          view.body.replaceChildren(h('details', {
            class: result.ok ? 'studio-tool' : 'studio-tool studio-error',
          },
          h('summary', { text: `${result.ok ? '✓ Sucesso' : '⚠ Erro'} · ${result.tool}` }),
          h('pre', { text: result.message })));
          view.content = '';
        }
      } else if (view.content !== message.content) {
        // O renderizador existente devolve nós; nenhum HTML do servidor é inserido diretamente.
        view.body.replaceChildren(message.error
          ? h('pre', { text: message.content })
          : renderMarkdown(message.content));
        view.content = message.content;
      }
    }
    if (nearBottom) this.timeline.scrollTop = this.timeline.scrollHeight;
  }

  private approvalCard(message: Message): HTMLElement {
    const approval = message.approval;
    if (!approval) return h('div');
    const state = this.state;
    const card = h('section', { class: 'studio-approval', attrs: { 'aria-label': 'Aprovação necessária' } },
      h('strong', { text: approval.kind === 'write' ? 'Aprovação de escrita' : 'Aprovação de comando' }),
      h('p', { text: approval.summary }),
    );
    if (approval.kind === 'command') {
      card.append(h('pre', { text: approval.check || approval.summary }));
    } else {
      card.append(h('code', { text: approval.path || 'Caminho não informado' }));
      const preview = h('div');
      const details = h('details', {},
        h('summary', { text: 'Revisar alterações · − removido / + adicionado' }), preview,
      );
      let built = false;
      details.addEventListener('toggle', () => {
        if (!details.open || built) return;
        built = true;
        preview.append(approval.oldContent === undefined || approval.newContent === undefined
          ? h('p', { text: 'Prévia indisponível. Revise o arquivo antes de aprovar.' })
          : diffView(approval.oldContent, approval.newContent));
      });
      card.append(details);
    }

    const actions = h('div', { class: 'studio-actions' });
    const statusLabel = (): string => approval.status === 'approved' ? 'Aprovado'
      : approval.status === 'rejected' ? 'Recusado' : 'Expirado ou encerrado';
    if (approval.status || !message.jobId) {
      actions.append(h('span', { text: approval.status ? statusLabel() : 'Aguardando identificador da tarefa' }));
      card.append(actions);
      return card;
    }

    const feedback = h('span', { class: 'studio-error', role: 'status' });
    const approve = action('Aprovar', () => void respond('approve'));
    const reject = action('Recusar', () => void respond('reject'));
    const respond = async (decision: 'approve' | 'reject'): Promise<void> => {
      approve.disabled = true;
      reject.disabled = true;
      feedback.textContent = '';
      try {
        const response = await fetch(
          `${API}/jobs/${encodeURIComponent(message.jobId ?? '')}/approvals/${encodeURIComponent(approval.id)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision }),
          },
        );
        if (response.status === 404 || response.status === 410) {
          approval.status = 'expired';
        } else {
          if (!response.ok) throw new Error(`Falha ao responder aprovação (HTTP ${response.status}).`);
          approval.status = decision === 'approve' ? 'approved' : 'rejected';
        }
        this.save(state);
        actions.replaceChildren(h('span', { text: statusLabel() }));
        if (this.state === state) this.syncMessages();
      } catch (error) {
        if (!approval.status) {
          approve.disabled = false;
          reject.disabled = false;
        }
        setText(feedback, errorText(error));
      }
    };
    actions.append(approve, reject, feedback);
    card.append(actions);
    return card;
  }

  private decisionCard(message: Message): HTMLElement {
    const decision = message.decision;
    if (!decision) return h('div');
    const state = this.state;
    const card = h('section', {
      class: 'studio-decision',
      attrs: { 'aria-label': 'Decisão necessária' },
    },
    h('strong', { text: 'Decidir' }),
    h('p', { text: decision.question }));

    const status = h('p', { class: 'studio-decision-status', role: 'status' });
    const feedback = h('p', { class: 'studio-error', role: 'status' });
    const note = h('input', {
      attrs: { type: 'text', maxlength: 500, placeholder: 'Contexto adicional, se necessário' },
    });
    note.value = decision.note ?? '';
    note.addEventListener('input', () => {
      if (decision.status !== 'pending' || this.respondingDecisions.has(decision)) return;
      decision.note = note.value.slice(0, 500);
      this.save(state);
    });

    const buttons: HTMLButtonElement[] = [];
    const options = h('div', { class: 'studio-decision-options' });
    const update = (): void => {
      const busy = this.respondingDecisions.has(decision);
      const disabled = busy || decision.status !== 'pending' || !message.jobId;
      for (const [index, button] of buttons.entries()) {
        button.disabled = disabled;
        button.classList.toggle('is-selected', decision.status === 'answered' && decision.choice === index);
      }
      note.disabled = disabled;
      setAttr(card, 'aria-busy', String(busy));
      setText(status, decision.status === 'answered'
        ? `Respondido · ${decision.options[decision.choice ?? -1] ?? 'Opção não informada'}`
        : decision.status === 'expired'
          ? 'Expirado ou encerrado'
          : busy
            ? 'Enviando resposta…'
            : message.jobId ? 'Aguardando sua decisão' : 'Aguardando identificador da tarefa');
    };

    const respond = async (choice: number): Promise<void> => {
      const jobId = message.jobId;
      if (!jobId || decision.status !== 'pending' || this.respondingDecisions.has(decision)) return;
      const observation = note.value.slice(0, 500).trim();
      decision.note = observation;
      this.respondingDecisions.add(decision);
      setText(feedback, '');
      update();
      this.save(state);

      try {
        const response = await fetch(
          `${API}/jobs/${encodeURIComponent(jobId)}/decisions/${encodeURIComponent(decision.id)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ choice, ...(observation ? { note: observation } : {}) }),
          },
        );
        if (!response.ok) {
          let detail = '';
          try {
            const text = await response.text();
            try {
              const data = obj(JSON.parse(text) as unknown);
              detail = str(data.error) || str(obj(data.error).message) || str(data.message);
            } catch {
              detail = text.trim();
            }
          } catch {
            // O status HTTP continua disponível mesmo se o corpo não puder ser lido.
          }
          if (response.status === 404 || response.status === 410) decision.status = 'expired';
          throw new Error(
            `Falha ao responder decisão (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`,
          );
        }

        decision.choice = choice;
        decision.status = 'answered';
      } catch (error) {
        setText(feedback, errorText(error));
      } finally {
        this.respondingDecisions.delete(decision);
        this.save(state);
        update();
        if (this.state === state) {
          this.syncMessages();
          // O término da tarefa pode ter reconstruído o cartão durante o POST.
          const currentFeedback = this.views.get(message.id)?.body.querySelector('.studio-decision-feedback');
          if (currentFeedback) setText(currentFeedback, feedback.textContent ?? '');
        }
      }
    };

    for (const [index, option] of decision.options.entries()) {
      const button = action(option, () => void respond(index));
      if (index === decision.recommended) {
        button.classList.add('is-recommended');
        button.append(h('span', { class: 'studio-decision-recommended', text: 'Recomendado' }));
      }
      buttons.push(button);
      options.append(button);
    }
    feedback.classList.add('studio-decision-feedback');
    card.append(
      options,
      h('label', { class: 'studio-decision-note' },
        h('span', { text: 'Observação opcional (até 500 caracteres)' }), note,
      ),
      status,
      feedback,
    );
    update();
    return card;
  }

  private syncWorkspace(): void {
    const value = this.state.workspace;
    if (value && !Array.from(this.workspace.options).some((option) => option.value === value)) {
      this.workspace.append(h('option', { text: value, attrs: { value } }));
    }
    this.workspace.value = value;
  }

  private startPolling(): void {
    this.stopPolling();
    const controller = new AbortController();
    this.polling = controller;
    void this.loadWorkspaces(controller);
    void this.loadJobs(controller);
    void this.loadStatus(controller);
    void this.loadProject();
    if (!this.recipes.length) void this.loadRecipes(controller);
    this.jobsTimer = window.setInterval(() => void this.loadJobs(controller), 5000);
    this.statusTimer = window.setInterval(() => void this.loadStatus(controller), 30000);
  }

  private stopPolling(): void {
    this.polling?.abort();
    this.polling = null;
    this.projectRequest?.abort();
    window.clearInterval(this.jobsTimer);
    window.clearInterval(this.statusTimer);
    this.jobsBusy = false;
    this.statusBusy = false;
  }

  private async getJson(url: string, signal: AbortSignal, method = 'GET'): Promise<Json> {
    const response = await fetch(url, { method, signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Falha ao consultar OmniRoute (HTTP ${response.status}).`);
    return obj(await response.json() as unknown);
  }

  private async loadRecipes(controller: AbortController): Promise<void> {
    try {
      const data = await this.getJson(`${API}/recipes`, controller.signal);
      this.recipes = list(data.recipes).map(obj).filter((r) => str(r.id) && str(r.corpo)).map((r) => ({
        id: str(r.id), titulo: str(r.titulo, str(r.id)), resumo: str(r.resumo), modo: str(r.modo), corpo: str(r.corpo),
      }));
      this.recipe.replaceChildren(
        h('option', { text: this.recipes.length ? 'Receitas…' : 'Sem receitas', attrs: { value: '' } }),
        ...this.recipes.map((r) => h('option', {
          text: `${r.modo === 'escrita' ? '✎ ' : ''}${r.titulo}`, attrs: { value: r.id, title: r.resumo },
        })),
      );
    } catch {
      // Sem receitas o estúdio funciona igual.
    }
  }

  /** Preenche o pedido com o roteiro da receita para o workspace atual (o usuário revisa antes de enviar). */
  private applyRecipe(): void {
    const r = this.recipes.find((item) => item.id === this.recipe.value);
    this.recipe.value = '';
    if (!r) return;
    const workspace = this.state.workspace || 'o projeto selecionado';
    this.input.value = `Receita: ${r.titulo}

${r.corpo.split('{{workspace}}').join(workspace)}`;
    this.input.focus();
    this.input.setSelectionRange(0, 0);
  }

  private async loadWorkspaces(controller: AbortController): Promise<void> {
    try {
      const data = await this.getJson(`${API}/workspaces`, controller.signal);
      if (controller.signal.aborted || this.polling !== controller) return;
      const workspaces = list(data.workspaces).map(obj).filter((item) => str(item.id));
      this.workspace.replaceChildren(
        h('option', { text: 'Selecione um workspace', attrs: { value: '' } }),
        ...workspaces.map((item) => h('option', {
          text: str(item.label, str(item.id)), attrs: { value: str(item.id) },
        })),
      );
      if (!this.state.workspace && !this.state.active) {
        const preferred = str(data.default);
        this.state.workspace = workspaces.some((item) => item.id === preferred)
          ? preferred : str(workspaces[0]?.id);
      }
      this.syncWorkspace();
      this.save();
      this.render();
      void this.loadProject();
    } catch (error) {
      if (controller.signal.aborted || this.polling !== controller) return;
      if (!this.workspace.options.length) {
        this.workspace.append(h('option', { text: errorText(error), attrs: { value: '' } }));
      }
      setAttr(this.workspace, 'title', errorText(error));
    }
  }

  private async loadJobs(controller: AbortController): Promise<void> {
    if (this.jobsBusy || controller.signal.aborted) return;
    this.jobsBusy = true;
    try {
      const data = await this.getJson(`${API}/jobs`, controller.signal);
      if (controller.signal.aborted || this.polling !== controller) return;
      const jobs = list(data.jobs).map(obj).filter((job) => str(job.id));
      // Reconcilia os botões para não tirar o foco a cada atualização de cinco segundos.
      const existing = new Map<string, HTMLButtonElement>();
      for (const child of Array.from(this.jobs.children)) {
        if (child instanceof HTMLButtonElement && child.dataset.job) existing.set(child.dataset.job, child);
      }
      const wanted = new Set<string>();
      for (const job of jobs) {
        const id = str(job.id);
        wanted.add(id);
        let button = existing.get(id);
        if (!button) {
          button = action('', () => {
            const latest = obj(stored(`job-view:${id}`));
            this.attachJob(Object.keys(latest).length ? latest : job);
          });
          button.dataset.job = id;
          this.jobs.append(button);
        }
        // O callback usa somente os campos necessários e atualizados, sem guardar a resposta inteira.
        button.onclick = () => this.attachJob(job);
        button.className = `studio-job${id === this.state.jobId ? ' is-active' : ''}`;
        setText(button, [
          str(job.title, id),
          `Estado: ${str(job.status, 'não informado')}`,
          `Início: ${dateLabel(job.startedAt)}`,
          ...(job.endedAt === undefined ? [] : [`Fim: ${dateLabel(job.endedAt)}`]),
          `Workspace: ${str(job.workspace, '—')} · Modelo: ${str(job.model, '—')}`,
          `Tokens: ${readable(job.tokens)}`,
        ].join('\n'));
      }
      for (const child of Array.from(this.jobs.children)) {
        if (!(child instanceof HTMLButtonElement) || !wanted.has(child.dataset.job ?? '')) child.remove();
      }
      if (!jobs.length) this.jobs.append(h('p', { class: 'studio-muted', text: 'Nenhuma tarefa encontrada.' }));
    } catch (error) {
      if (!controller.signal.aborted && this.polling === controller) {
        const previous = this.jobs.querySelector('.studio-poll-error');
        if (previous) previous.textContent = errorText(error);
        else this.jobs.append(h('p', { class: 'studio-poll-error studio-error', text: errorText(error) }));
      }
    } finally {
      if (this.polling === controller) this.jobsBusy = false;
    }
  }

  private async loadStatus(controller: AbortController): Promise<void> {
    if (this.statusBusy || controller.signal.aborted) return;
    this.statusBusy = true;
    try {
      const data = await this.getJson(`${API}/status`, controller.signal);
      if (controller.signal.aborted || this.polling !== controller) return;
      this.usage.replaceChildren();
      this.alerts.replaceChildren();
      if (data.ok === false || typeof data.error === 'string') {
        this.alerts.append(h('p', { class: 'studio-error', text: str(data.error, 'OmniRoute indisponível.') }));
      }

      const providers = list(data.providers).map(obj);
      for (const provider of providers) {
        const label = str(provider.label, str(provider.provider, 'Provedor'));
        const quotas = list(provider.quotas).map(obj);
        const exhausted = quotas.some((quota) => (num(quota.usedPct) ?? 0) >= 100);
        const state = str(provider.state, 'unknown');
        const stateLabel = ({ ok: 'saudável', limited: 'limitado', error: 'erro', unknown: 'desconhecido' } as Record<string, string>)[state] ?? state;
        const card = h('section', { class: 'studio-stat-card' },
          h('strong', { text: label }),
          h('p', { class: 'studio-muted', text: `${stateLabel}${provider.active === false ? ' · inativo' : ''}${str(provider.plan) ? ` · ${str(provider.plan)}` : ''}` }),
        );
        if (state === 'error' || state === 'limited' || exhausted || str(provider.error)) {
          this.alerts.append(h('p', {
            class: state === 'error' ? 'studio-error' : 'studio-warning',
            text: `${label}: ${exhausted ? 'cota esgotada' : stateLabel}${str(provider.error) ? ` · ${str(provider.error)}` : ''}`,
          }));
        }
        for (const quota of quotas) {
          const name = str(quota.name, 'Cota');
          const title = /session|5h|five/i.test(name) ? '5 horas'
            : /week|7d|seven/i.test(name) ? 'Semanal' : name;
          const pct = num(quota.usedPct);
          const labelEl = h('label', { class: 'studio-quota' },
            h('span', { text: `${title}: ${metric(pct, '% usado')}` }),
          );
          if (pct !== undefined) {
            labelEl.append(h('progress', {
              attrs: { max: 100, value: Math.max(0, Math.min(100, pct)), 'aria-label': `${label} · ${title}` },
            }));
          }
          if (quota.resetAt !== undefined) {
            labelEl.append(h('small', { class: 'studio-muted', text: `Renova: ${dateLabel(quota.resetAt)}` }));
          }
          card.append(labelEl);
        }
        if (!quotas.length) card.append(h('small', { class: 'studio-muted', text: 'Cotas não informadas.' }));
        if (provider.limitedUntil !== undefined) {
          card.append(h('p', { text: `Limite até: ${dateLabel(provider.limitedUntil)}` }));
        }
        this.usage.append(card);
      }
      if (!providers.length) this.usage.append(h('p', { class: 'studio-muted', text: 'Sem dados de provedores/contas.' }));
      if (!this.alerts.childElementCount) {
        this.alerts.append(h('p', { class: 'studio-muted', text: 'Nenhum alerta informado.' }));
      }

      const summary = obj(data.summary);
      this.usage.append(
        h('h3', { text: 'Totais de uso' }),
        h('p', { text: `Requisições: ${metric(summary.requests)} · Tokens: ${metric(summary.totalTokens)}` }),
        h('p', { text: `Sucesso: ${metric(summary.successRatePct, '%')} · Latência média: ${metric(summary.avgLatencyMs, ' ms')}` }),
      );
      for (const raw of list(data.byProvider)) {
        const item = obj(raw);
        this.usage.append(h('p', {
          text: `${str(item.provider, 'Provedor')}: ${metric(item.requests)} requisições · ${metric(item.totalTokens)} tokens · ${metric(item.successRatePct, '%')} de sucesso`,
        }));
      }

      this.usage.append(h('h3', { text: 'Saúde dos combos' }));
      const combos = list(data.combos).map(obj);
      for (const combo of combos) {
        const card = h('section', { class: 'studio-stat-card' },
          h('strong', { text: str(combo.name, 'Combo') }),
        );
        for (const raw of list(combo.targets)) {
          const target = obj(raw);
          // A escala de successRate não está documentada; exibe o valor sem converter para %.
          card.append(h('p', {
            text: `${str(target.model, 'Modelo')}: ${metric(target.requests)} requisições · taxa de sucesso: ${metric(target.successRate)} · ${str(target.lastStatus, 'estado não informado')} · ${metric(target.avgLatencyMs, ' ms')}`,
          }));
        }
        this.usage.append(card);
      }
      if (!combos.length) this.usage.append(h('p', { class: 'studio-muted', text: 'Saúde dos combos não informada.' }));
    } catch (error) {
      if (!controller.signal.aborted && this.polling === controller) {
        this.usage.replaceChildren(h('p', { class: 'studio-error', text: errorText(error) }));
        this.alerts.replaceChildren(h('p', { class: 'studio-warning', text: 'Não foi possível verificar os alertas do OmniRoute.' }));
      }
    } finally {
      if (this.polling === controller) this.statusBusy = false;
    }
  }

  private async loadProject(refresh = false): Promise<void> {
    this.projectRequest?.abort();
    const workspace = this.state.workspace;
    this.refreshCard.disabled = !workspace;
    if (!this.opened || !workspace) {
      this.project.replaceChildren(h('p', { class: 'studio-muted', text: 'Selecione um workspace para consultar o cartão.' }));
      return;
    }
    const controller = new AbortController();
    this.projectRequest = controller;
    this.refreshCard.disabled = true;
    this.project.replaceChildren(h('p', { class: 'studio-muted', text: refresh ? 'Atualizando cartão…' : 'Carregando cartão…' }));
    try {
      const data = await this.getJson(
        `${API}/context?workspace=${encodeURIComponent(workspace)}`,
        controller.signal,
        refresh ? 'POST' : 'GET',
      );
      if (controller.signal.aborted || this.projectRequest !== controller) return;
      this.project.replaceChildren(h('span', {
        class: 'studio-badge',
        text: data.cached === true ? 'cache' : data.cached === false ? 'atualizado' : 'origem não informada',
      }));
      if (typeof data.card === 'string') {
        this.project.append(renderMarkdown(data.card));
      } else {
        const card = obj(data.card);
        const labels: Record<string, string> = {
          stack: 'Stack', scripts: 'Scripts', structure: 'Estrutura', notes: 'Notas',
        };
        for (const [key, label] of Object.entries(labels)) {
          this.project.append(h('h3', { text: label }), h('pre', { text: readable(card[key]) }));
        }
        const extra = Object.fromEntries(Object.entries(card).filter(([key]) => !(key in labels)));
        if (Object.keys(extra).length) {
          this.project.append(h('details', {},
            h('summary', { text: 'Outros dados do projeto' }), h('pre', { text: readable(extra) }),
          ));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && this.projectRequest === controller) {
        this.project.replaceChildren(h('p', { class: 'studio-error', text: errorText(error) }));
      }
    } finally {
      if (this.projectRequest === controller) this.refreshCard.disabled = !this.state.workspace;
    }
  }
}
