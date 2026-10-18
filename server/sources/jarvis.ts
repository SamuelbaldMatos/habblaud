// Jarvis, o gerente do escritório: um personagem fixo na sala Diretoria que aparece sempre, mesmo sem sessão aberta.
// Ele não tem transcript próprio: o estado vem das tarefas do estúdio de código (AgentRuntime) — trabalhando enquanto
// há tarefa rodando, esperando quando há aprovação ou decisão pendente, e o balão com a etapa atual.
// Clique nele (ou tecla J) abre o estúdio com o Jarvis como gerente (client/src/ui/studio.ts).
import type { AppearanceParts } from '../../shared/appearance';
import type { SourceInfo } from '../../shared/types';
import type { Office } from '../model/office';

export const JARVIS_ID = 'jarvis:gerente';
export const JARVIS_SESSION = 'jarvis-gerente';
/** Pasta "virtual" da sala: o escritório agrupa salas pela pasta; esta não existe no disco. */
export const JARVIS_ROOM_CWD = '/habblaud/Diretoria';

/** Camisa clara, gravata azul-marinho, calça escura, cabelo curto com risca: o gerente. */
export const JARVIS_LOOK: AppearanceParts = {
  hairStyle: 'side_part',
  hair: '#2b2118',
  top: '#f4f4f0',
  topAccent: '#2f4c7d',
  topStyle: 'shirt_tie',
  bottom: '#262a33',
  bottomStyle: 'pants',
  shoes: '#121d2b',
  accessory: 'none',
  facialHair: 'none',
};

/** O que o Jarvis precisa saber de uma tarefa do estúdio (subconjunto do AgentStreamEvent). */
export interface JarvisJobEvent {
  jobId: string;
  title: string;
  type: string;
  activity?: string;
  model?: string;
  error?: string;
}

export interface JarvisNames {
  character(roomId: string): { name: string } | undefined;
  setCharacter(roomId: string, c: { name: string; look: 'f' | 'm'; seed: number; parts?: AppearanceParts; owner?: string }): void;
}

export class JarvisSource {
  private seq = 0;
  private readonly running = new Map<string, string>();
  private readonly waiting = new Set<string>();

  constructor(private readonly opts: { office: Office; names: JarvisNames; roomId: string; now?: () => number }) {}

  start(): void {
    // Personagem da sala fixado uma vez (o editor de personagem continua podendo trocá-lo depois).
    if (!this.opts.names.character(this.opts.roomId)) {
      this.opts.names.setCharacter(this.opts.roomId, { name: 'Jarvis', look: 'm', seed: 7, parts: JARVIS_LOOK, owner: JARVIS_SESSION });
    }
    const now = (this.opts.now ?? Date.now)();
    this.opts.office.addMain({
      id: JARVIS_ID,
      account: 'omniroute',
      sessionId: JARVIS_SESSION,
      cwd: JARVIS_ROOM_CWD,
      role: 'Gerente',
      startedAt: now,
      status: 'idle',
    });
  }

  sources(): SourceInfo[] {
    return [{ label: 'Jarvis (gerente)', path: 'estúdio de código', sessions: 1, ok: true }];
  }

  /** Um evento de tarefa do estúdio: ajusta o estado do Jarvis e o balão. */
  onJob(ev: JarvisJobEvent): void {
    const { office } = this.opts;
    const at = (this.opts.now ?? Date.now)();
    const say = (text: string, icon: string, kind: 'other' | 'done' = 'other', error = false) => {
      office.addActivity(JARVIS_ID, {
        id: `${JARVIS_ID}:${++this.seq}`, at, kind, icon,
        text: text.length > 46 ? `${text.slice(0, 45)}…` : text,
        detail: `${ev.title}${ev.model ? ` · ${ev.model}` : ''}`.slice(0, 300),
        ...(error ? { error: true } : {}),
      }, true);
    };
    if (ev.type === 'job') {
      this.running.set(ev.jobId, ev.title);
      say(ev.title, '🧭');
    } else if (ev.type === 'approval') {
      this.waiting.add(ev.jobId);
      say('Esperando sua aprovação', '✋');
    } else if (ev.type === 'tool_result' || ev.type === 'text') {
      this.waiting.delete(ev.jobId);
    } else if (ev.type === 'activity' && ev.activity) {
      say(ev.activity, '🔀');
    } else if (ev.type === 'error') {
      say(`Falhou: ${ev.error ?? ev.title}`, '⚠️', 'other', true);
    } else if (ev.type === 'done') {
      this.running.delete(ev.jobId);
      this.waiting.delete(ev.jobId);
      say(`Entregou: ${ev.title}`, '📦', 'done');
    }
    const status = this.waiting.size ? 'waiting' : this.running.size ? 'working' : 'idle';
    office.setStatus(JARVIS_ID, status, status === 'waiting' ? 'aprovar ou decidir no estúdio' : undefined);
  }
}
