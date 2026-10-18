// Receitas do estúdio de código: roteiros prontos (adaptados do vibe-coding-toolkit, MIT) em shared/recipes/*.md.
// O estúdio lista com GET /api/omniroute/recipes e, ao escolher uma, preenche o pedido com o roteiro do workspace.
// Arquivos lidos uma vez e guardados em memória; um arquivo fora do formato é ignorado (não derruba a lista).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Recipe {
  id: string;
  titulo: string;
  resumo: string;
  modo: 'leitura' | 'escrita';
  combos: string[];
  /** Roteiro com {{workspace}} no lugar do projeto. */
  corpo: string;
}

const ID = /^[a-z0-9-]{1,48}$/;
const MAX_BYTES = 16_000;

/** Lê o frontmatter simples (chave: valor) e o corpo de uma receita; undefined se faltar campo obrigatório. */
export function parseRecipe(text: string): Recipe | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trimStart());
  if (!m) return undefined;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const corpo = m[2].trim();
  if (!ID.test(meta.id ?? '') || !meta.titulo || !meta.resumo || !corpo) return undefined;
  return {
    id: meta.id,
    titulo: meta.titulo.slice(0, 60),
    resumo: meta.resumo.slice(0, 200),
    modo: meta.modo === 'escrita' ? 'escrita' : 'leitura',
    combos: (meta.combos ?? '').split(',').map((c) => c.trim()).filter((c) => /^[a-z0-9-]{1,48}$/.test(c)),
    corpo,
  };
}

/** Todas as receitas válidas da pasta, em ordem de título. Pasta ausente = lista vazia. */
export function loadRecipes(dir: string): Recipe[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'LEIA-ME.md');
  } catch {
    return [];
  }
  const out: Recipe[] = [];
  for (const name of names) {
    try {
      const text = readFileSync(join(dir, name), 'utf8');
      if (Buffer.byteLength(text) > MAX_BYTES) continue;
      const r = parseRecipe(text);
      if (r) out.push(r);
    } catch {
      // Arquivo ilegível: fica de fora.
    }
  }
  return out.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
}
