import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyWorkspaceWrite, prepareWorkspaceWrite, readWorkspaceFile, resolveWorkspaceFile, runApprovedCheck } from './agent-tools';
import { tempDir } from '../test/fixtures';

describe('ferramentas de workspace do agente', () => {
  it('rejeita traversal, caminhos absolutos e arquivos locais protegidos', async () => {
    const tmp = tempDir();
    try {
      await expect(resolveWorkspaceFile(tmp.dir, '../fora.txt')).rejects.toThrow('fora do workspace');
      await expect(resolveWorkspaceFile(tmp.dir, join(tmp.dir, 'fora.txt'))).rejects.toThrow('relativo');
      await expect(resolveWorkspaceFile(tmp.dir, '.env')).rejects.toThrow('conteúdo local protegido');
      await expect(resolveWorkspaceFile(tmp.dir, 'docker-compose.override.yml')).rejects.toThrow('conteúdo local protegido');
    } finally {
      tmp.cleanup();
    }
  });

  it('não atravessa symlinks do workspace', async () => {
    if (process.platform === 'win32') return;
    const tmp = tempDir();
    try {
      const outside = tempDir();
      try {
        writeFileSync(join(outside.dir, 'secret.txt'), 'segredo');
        symlinkSync(outside.dir, join(tmp.dir, 'link'), 'dir');
        await expect(readWorkspaceFile(tmp.dir, 'link/secret.txt')).rejects.toThrow('symlinks');
      } finally {
        outside.cleanup();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('só aplica a proposta aprovada se o arquivo não mudou durante a revisão', async () => {
    const tmp = tempDir();
    try {
      const target = join(tmp.dir, 'example.ts');
      writeFileSync(target, 'const value = 1;\n');
      const proposal = await prepareWorkspaceWrite(tmp.dir, 'example.ts', 'const value = 2;\n');
      expect(await readWorkspaceFile(tmp.dir, 'example.ts')).toBe('const value = 1;\n');
      writeFileSync(target, 'const value = 3;\n');
      await expect(applyWorkspaceWrite(tmp.dir, proposal)).rejects.toThrow('mudou enquanto aguardava aprovação');
      expect(await readWorkspaceFile(tmp.dir, 'example.ts')).toBe('const value = 3;\n');

      const currentProposal = await prepareWorkspaceWrite(tmp.dir, 'example.ts', 'const value = 4;\n');
      await applyWorkspaceWrite(tmp.dir, currentProposal);
      expect(await readWorkspaceFile(tmp.dir, 'example.ts')).toBe('const value = 4;\n');
    } finally {
      tmp.cleanup();
    }
  });

  it('não executa nomes fora da allowlist', async () => {
    const tmp = tempDir();
    try {
      mkdirSync(join(tmp.dir, 'node_modules'), { recursive: true });
      await expect(runApprovedCheck(tmp.dir, 'npm install', new AbortController().signal)).rejects.toThrow('não autorizada');
    } finally {
      tmp.cleanup();
    }
  });
});
