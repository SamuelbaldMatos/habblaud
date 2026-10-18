// Workspaces do estúdio de código: o Habblaud (HABBLAUD_AGENT_WORKSPACE) e cada projeto encontrado um nível
// abaixo das raízes de HABBLAUD_AGENT_ROOTS (pastas com package.json ou .git). Decisão do usuário em 2026-10-18:
// o estúdio pode trabalhar em todas as pastas; as proteções de caminho (agent-tools) e as aprovações continuam.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Pastas que nunca viram workspace: dado de cliente (vault), modelos, sistema e lixeira. */
const EXCLUDED = new Set([
  'carecabrain', 'ollama', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)',
  'programdata', 'appdata', 'node_modules', 'backups',
]);

function isProject(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'));
}

function safeId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'projeto';
}

/**
 * id → pasta. O primeiro é o padrão. Ids repetidos ganham sufixo (-2, -3...). Raiz ilegível é ignorada.
 * `roots` vem de HABBLAUD_AGENT_ROOTS (separado por vírgula).
 */
export function discoverWorkspaces(main: string | undefined, roots: string[], mainId = 'habblaud'): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (id: string, dir: string) => {
    let key = safeId(id);
    for (let n = 2; out[key] !== undefined; n++) key = `${safeId(id)}-${n}`;
    out[key] = dir;
  };
  if (main) add(mainId, main);
  for (const root of roots.map((r) => r.trim()).filter(Boolean)) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.') || EXCLUDED.has(name.toLowerCase())) continue;
      const dir = join(root, name);
      try {
        const st = statSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (main && dir === main) continue;
      if (isProject(dir)) add(basename(dir), dir);
    }
  }
  return out;
}
