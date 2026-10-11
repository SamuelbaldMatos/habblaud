import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface MemoryRecord {
  id: string;
  titulo: string;
  resumo: string;
  evidencias: string[];
}

export interface AgentMemory {
  prepare(task: string, signal?: AbortSignal): Promise<string>;
  record(value: MemoryRecord): Promise<string>;
}

type BrainTool = 'cerebro_buscar' | 'cerebro_rotear' | 'cerebro_ler_nota' | 'cerebro_registrar';
type BrainCall = (tool: BrainTool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createAgentMemory(options: { cli: string; project: string; call?: BrainCall }): AgentMemory {
  if (!isAbsolute(options.cli) || !options.project.trim() || options.project.length > 200) {
    throw new Error('Configure um caminho absoluto para o Cérebro e um projeto explícito.');
  }
  const call: BrainCall = options.call ?? ((tool, args, signal) => new Promise((resolve, reject) => {
    // No shell, no task arguments in the process list, bounded output and time.
    const child = execFile(process.execPath, [options.cli, tool, '--stdin'], {
      timeout: 40_000, maxBuffer: 256 * 1024, windowsHide: true, signal,
      env: { ...process.env, CEREBRO_DELEGATED: '1' },
    }, (error, stdout) => {
      if (error) { reject(new Error('Cérebro indisponível ou tempo de consulta excedido.')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Resposta inválida do Cérebro.')); }
    });
    child.stdin?.on('error', () => { /* execFile reports process failure */ });
    child.stdin?.end(JSON.stringify(args));
  }));

  return {
    async prepare(task, signal) {
      const found = object(await call('cerebro_buscar', { consulta: task.slice(0, 12000), projeto: options.project }, signal));
      const routing = object(await call('cerebro_rotear', {
        tarefa: `Projeto ${options.project}. Engenharia de software TypeScript Node, implementação e revisão. ${task.slice(0, 6000)}`,
      }, signal));
      const specialists = (Array.isArray(routing.resultados) ? routing.resultados : [])
        .map(object).filter(row => row.setor === 'tecnologia-software' && row.tipo === 'agente')
        .slice(0, 3).map(row => ({ nome: row.nome, faz: String(row.faz ?? '').slice(0, 600) }));
      const notes: Array<{ nota: string; conteudo: string }> = [];
      for (const row of (Array.isArray(found.resultados) ? found.resultados : []).slice(0, 8)) {
        const note = object(row).nota;
        // Raw sessions, personal dossiers and unrelated departments never enter cloud context.
        if (typeof note !== 'string' || !/^(conhecimento\/sessoes-compartilhadas|entregas\/tecnologia-software)\/[A-Za-z0-9_./-]+\.md$/.test(note) || note.includes('..')) continue;
        const loaded = object(await call('cerebro_ler_nota', { nota: note }, signal));
        if (typeof loaded.conteudo !== 'string') continue;
        const field = /^projeto: (.+)$/m.exec(loaded.conteudo)?.[1];
        let owner = field;
        try { if (field?.startsWith('"')) owner = JSON.parse(field) as string; } catch { continue; }
        if (owner !== options.project) continue;
        notes.push({ nota: note, conteudo: loaded.conteudo.slice(0, 3000) });
        if (notes.length === 2) break;
      }
      return JSON.stringify({ projeto: options.project, busca: found.busca ?? 'lexical', especialistas: specialists, notas: notes });
    },
    async record(value) {
      const result = object(await call('cerebro_registrar', {
        ...value, projeto: options.project, origem: 'habblaud-runtime', tipo: 'aprendizado',
      }));
      if (result.registrado !== true || typeof result.nota !== 'string') throw new Error('Cérebro não confirmou o registro.');
      const vector = object(result.vetor);
      return `${result.nota}${vector.indexado === false ? ' (vetor pendente; busca lexical disponível)' : ''}`;
    },
  };
}
