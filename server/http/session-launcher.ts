import { posix } from 'node:path';
import { PROMPT_MAX } from '../spawn/spawn';

export const SESSION_DELEGATION_PREFIX = '[Tarefa delegada pelo Jarvis do Habblaud — trabalhe até concluir; peça aprovação pelo escritório quando precisar]';

/** Tarefa útil que cabe no limite do Novo agente junto com a linha fixa e a quebra de linha. */
export const MAX_SESSION_TASK = PROMPT_MAX - SESSION_DELEGATION_PREFIX.length - 1;

const UNAVAILABLE = 'O Novo agente está desligado (HABBLAUD_PTY=1 e npm run codex:bridge no PC)';

export type SessionLaunchResult =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string };

export interface SessionLauncher {
  launch(workspaceDir: string, prompt: string): SessionLaunchResult;
}

export interface SessionLauncherOptions {
  spawn: {
    available(): boolean;
    submit(raw: unknown): { spawn: { id: string; status: string } } | { error: string; reason: string };
  };
  hostPath: (workspaceDir: string) => string | undefined;
}

/** Encaminha ao Novo agente existente; não executa comandos nem abre outra fila. */
export function createSessionLauncher(opts: SessionLauncherOptions): SessionLauncher {
  return {
    launch(workspaceDir, prompt) {
      try {
        if (!opts.spawn.available()) return { ok: false, error: UNAVAILABLE };
        const folder = opts.hostPath(workspaceDir);
        if (!folder?.trim()) {
          return {
            ok: false,
            error: `Não há caminho no PC para o workspace "${workspaceDir}". Configure HABBLAUD_HOST_PATHS com pastaContainer=pastaHost.`,
          };
        }

        // O SpawnService valida o pedido inteiro, incluindo a linha fixa adicionada pelo runtime.
        // Nunca corta a tarefa silenciosamente para fazê-la caber no limite.
        const result = opts.spawn.submit({ folder, prompt });
        if ('error' in result) return { ok: false, error: result.reason || result.error };
        if (result.spawn.status === 'failed') {
          return { ok: false, error: `O pedido ${result.spawn.id} falhou ao abrir a sessão do Claude Code.` };
        }
        return { ok: true, id: result.spawn.id, status: result.spawn.status };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Falha ao solicitar uma sessão do Claude Code.',
        };
      }
    },
  };
}

interface PathMapping {
  container: string;
  host: string;
}

/** Normaliza o caminho do container sem depender do sistema operacional do servidor. */
function containerPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

/**
 * Traduz pelo prefixo de pasta mais longo, nunca por um pedaço de nome.
 * Sem configuração, o servidor roda no próprio computador e preserva o caminho recebido.
 * Com configuração, uma pasta não mapeada falha em vez de enviar um caminho do container ao PC.
 */
export function hostPathMapper(
  env: Readonly<Record<string, string | undefined>>,
): (workspaceDir: string) => string | undefined {
  const raw = env.HABBLAUD_HOST_PATHS;
  if (!raw?.trim()) return (workspaceDir) => workspaceDir;

  const mappings: PathMapping[] = [];
  for (const entry of raw.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const source = entry.slice(0, separator).trim();
    const host = entry.slice(separator + 1).trim();
    if (!source || !host || source.includes('\0') || host.includes('\0')) continue;
    const container = containerPath(source);
    if (!posix.isAbsolute(container)) continue;
    mappings.push({ container, host });
  }
  mappings.sort((a, b) => b.container.length - a.container.length);

  return (workspaceDir) => {
    if (!workspaceDir || workspaceDir.includes('\0')) return undefined;
    const path = containerPath(workspaceDir);
    const mapping = mappings.find(({ container }) =>
      path === container || path.startsWith(container === '/' ? '/' : `${container}/`));
    if (!mapping) return undefined;

    const suffix = path.slice(mapping.container.length).replace(/^\/+/, '');
    const windows = /^[A-Za-z]:/.test(mapping.host);
    const separator = windows ? '\\' : '/';
    const host = windows ? mapping.host.replace(/\//g, '\\') : mapping.host;
    if (!suffix) return host;
    return `${host.replace(/[\\/]+$/, '')}${separator}${windows ? suffix.replace(/\//g, '\\') : suffix}`;
  };
}
