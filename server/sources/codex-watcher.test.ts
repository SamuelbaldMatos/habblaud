import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { CodexWatcher } from './codex-watcher';
import { opaqueSessionId } from './privacy';

describe('CodexWatcher', () => {
  it('projects only recent metadata and marks sessions offline after the freshness window', () => {
    const temp = tempDir();
    try {
      const now = Date.now();
      const cwd = process.cwd();
      const folder = join(temp.dir, '2026', '10', '08');
      mkdirSync(folder, { recursive: true });
      const file = join(folder, 'rollout-synthetic.jsonl');
      const privateMarker = 'PRIVATE_CODEX_MESSAGE_AND_RESPONSE';
      const sessionId = '01a11dfc-2ffb-7970-8374-c7326ee60771';
      const metadata = {
        type: 'session_meta',
        payload: {
          id: sessionId,
          session_id: sessionId,
          timestamp: new Date(now - 60_000).toISOString(),
          cwd,
          originator: 'vscode',
          source: 'vscode',
          model_provider: 'openai',
          base_instructions: 'PRIVATE_CODEX_BASE_INSTRUCTIONS',
        },
      };
      writeFileSync(
        file,
        `${JSON.stringify(metadata)}\n${JSON.stringify({ type: 'response_item', payload: { text: privateMarker } })}\n`,
      );
      utimesSync(file, new Date(now - 10_000), new Date(now - 10_000));

      let clock = now;
      const office = new Office({
        names: new NameStore(null),
        version: 'test',
        startedAt: now,
        accounts: () => [],
        sources: () => [],
        accountName: () => undefined,
        now: () => clock,
      });
      const watcher = new CodexWatcher({ sessionsDir: temp.dir, office, now: () => clock });
      const agentId = `codex:${opaqueSessionId('codex', sessionId)}`;

      watcher.poll();
      expect(office.get(agentId)?.status).toBe('working');
      expect(office.get(agentId)?.sessionId).not.toBe(sessionId);
      const details = JSON.stringify(office.detail(agentId));
      expect(details).toContain('Atividade recente no Codex');
      expect(details).not.toContain(sessionId);
      expect(details).not.toContain(cwd);
      expect(details).not.toContain(privateMarker);
      expect(details).not.toContain('PRIVATE_CODEX_BASE_INSTRUCTIONS');
      expect(JSON.stringify(watcher.sources())).not.toContain(temp.dir);

      clock += 31 * 60_000;
      watcher.poll();
      expect(office.get(agentId)?.status).toBe('offline');
      expect(watcher.sources()[0]).toMatchObject({ label: 'Codex (experimental)', sessions: 0, ok: true });
      watcher.stop();
    } finally {
      temp.cleanup();
    }
  });
});
