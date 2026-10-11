import { describe, expect, it } from 'vitest';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { VscodeActivitySource } from './vscode';
import { opaqueSessionId } from './privacy';

function createSource(now = 1_800_000_000_000) {
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: now,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    now: () => now,
  });
  return { office, source: new VscodeActivitySource({ office, path: 'C:\\Users\\test\\.copilot\\hooks', now: () => now }) };
}

describe('VscodeActivitySource', () => {
  it('keeps only event metadata and never stores prompts, tool arguments, or output', () => {
    const { office, source } = createSource();
    const result = source.record({
      event: 'UserPromptSubmit',
      sessionId: 'session-1',
      cwd: process.cwd(),
      prompt: 'private prompt marker',
      response: 'private response marker',
      tool_input: { password: 'private argument marker' },
      tool_output: 'private output marker',
    });

    expect(result).toEqual({ ok: true });
    const agentId = `vscode:${opaqueSessionId('vscode', 'session-1')}`;
    const details = JSON.stringify(office.detail(agentId));
    expect(details).toContain('Nova mensagem para o agente');
    expect(details).not.toContain('session-1');
    expect(details).not.toContain(process.cwd());
    expect(details).not.toContain('private prompt marker');
    expect(details).not.toContain('private response marker');
    expect(details).not.toContain('private argument marker');
    expect(details).not.toContain('private output marker');
  });

  it('updates the session status using lifecycle events without recording tool content', () => {
    const { office, source } = createSource();
    const cwd = process.cwd();
    const agentId = `vscode:${opaqueSessionId('vscode', 'session-2')}`;

    expect(source.record({ event: 'SessionStart', sessionId: 'session-2', cwd }).ok).toBe(true);
    expect(source.record({ event: 'PreToolUse', sessionId: 'session-2', cwd, toolName: 'read_file', tool_input: 'secret' }).ok).toBe(true);
    expect(office.get(agentId)?.status).toBe('working');
    expect(source.record({ event: 'Stop', sessionId: 'session-2', cwd, response: 'secret' }).ok).toBe(true);
    expect(office.get(agentId)?.status).toBe('idle');
    expect(JSON.stringify(office.detail(agentId))).not.toContain('secret');
  });

  it('rejects malformed or non-local session metadata', () => {
    const { source } = createSource();

    expect(source.record({ event: 'UserPromptSubmit', sessionId: '../escape', cwd: process.cwd() }).ok).toBe(false);
    expect(source.record({ event: 'UserPromptSubmit', sessionId: 'session-3', cwd: 'relative\\workspace' }).ok).toBe(false);
    expect(source.record({ event: 'PostToolUse', sessionId: 'session-3', cwd: process.cwd() }).ok).toBe(false);
  });
});
