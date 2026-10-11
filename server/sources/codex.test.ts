import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_MAX_RECORD_BYTES, CODEX_RECENT_WINDOW_MS, readCodexSessionMetadata } from './codex';

const roots: string[] = [];

function createRoot(): string {
  const root = join(process.cwd(), `.codex-synthetic-${randomUUID()}`);
  mkdirSync(root);
  roots.push(root);
  return root;
}

function addRollout(
  root: string,
  record: Record<string, unknown> | string,
  modifiedAt = Date.now(),
  secondLine = '{"type":"event","prompt":"SENSITIVE_PROMPT_SENTINEL","response":"SENSITIVE_RESPONSE_SENTINEL"}',
): string {
  const date = new Date(modifiedAt);
  const day = join(
    root,
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  );
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-${randomUUID()}.jsonl`);
  const firstLine = typeof record === 'string' ? record : JSON.stringify(record);
  writeFileSync(file, `${firstLine}\n${secondLine}\n`, 'utf8');
  utimesSync(file, date, date);
  return file;
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session_meta',
    payload: {
      id: randomUUID(),
      cwd: '/synthetic/workspace',
      timestamp: new Date().toISOString(),
      originator: 'codex-cli',
      source: 'cli',
      model_provider: 'synthetic-provider',
      base_instructions: 'SENSITIVE_INSTRUCTIONS_SENTINEL',
      dynamic_tools: ['SENSITIVE_TOOL_SENTINEL'],
      ...overrides,
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex session metadata reader', () => {
  it('returns only allowlisted payload metadata and never reads out later content', () => {
    const root = createRoot();
    const file = addRollout(root, validRecord());
    const result = readCodexSessionMetadata(root);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toEqual({
      session_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      cwd: '/synthetic/workspace',
      timestamp: expect.any(String),
      originator: 'codex-cli',
      source: 'cli',
      model_provider: 'synthetic-provider',
      modified_at: statSync(file).mtimeMs,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SENSITIVE_PROMPT_SENTINEL');
    expect(serialized).not.toContain('SENSITIVE_RESPONSE_SENTINEL');
    expect(serialized).not.toContain('SENSITIVE_INSTRUCTIONS_SENTINEL');
    expect(serialized).not.toContain('SENSITIVE_TOOL_SENTINEL');
    expect(Object.keys(result.sessions[0] ?? {}).sort()).toEqual([
      'cwd',
      'model_provider',
      'modified_at',
      'originator',
      'session_id',
      'source',
      'timestamp',
    ]);
  });

  it('filters old files by modification time and never returns more than twenty sessions', () => {
    const root = createRoot();
    const now = Date.now();
    for (let i = 0; i < 22; i++) addRollout(root, validRecord(), now - i * 1000);
    addRollout(root, validRecord(), now - CODEX_RECENT_WINDOW_MS - 60_000);

    const result = readCodexSessionMetadata(root, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(20);
    expect(result.sessions.every((session) => session.modified_at >= now - CODEX_RECENT_WINDOW_MS)).toBe(true);
  });

  it('rejects flattened, malformed, wrong-type, invalid-field, and oversized first records safely', () => {
    const root = createRoot();
    const now = Date.now();
    addRollout(root, { type: 'session_meta', id: randomUUID(), cwd: '/synthetic/workspace', timestamp: new Date(now).toISOString() }, now);
    addRollout(root, { type: 'session_meta', payload: 'not-an-object' }, now);
    addRollout(root, { ...validRecord(), type: 'response' }, now);
    addRollout(root, validRecord({ id: 'not-a-session-id' }), now);
    addRollout(root, validRecord({ cwd: 'relative/workspace' }), now);
    addRollout(root, validRecord({ cwd: 'C:relative/workspace' }), now);
    addRollout(root, validRecord({ timestamp: '2026-02-30T12:00:00Z' }), now);
    addRollout(root, '{"type":', now);
    addRollout(root, validRecord({ base_instructions: 'x'.repeat(CODEX_MAX_RECORD_BYTES) }), now);

    const result = readCodexSessionMetadata(root, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toEqual([]);
    expect(result.rejections).toMatchObject({
      invalid_record: 2,
      invalid_session_id: 1,
      unexpected_record_type: 1,
      invalid_cwd: 2,
      invalid_timestamp: 1,
      malformed_json: 1,
      record_too_large: 1,
    });
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_PROMPT_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_RESPONSE_SENTINEL');
  });

  it('reports typed failures for invalid options and an unavailable root', () => {
    expect(readCodexSessionMetadata('unused', { maxSessions: 21 })).toEqual({ ok: false, error: 'invalid_options' });
    expect(readCodexSessionMetadata(join(process.cwd(), `.missing-codex-${randomUUID()}`))).toEqual({
      ok: false,
      error: 'root_unavailable',
    });
  });
});
