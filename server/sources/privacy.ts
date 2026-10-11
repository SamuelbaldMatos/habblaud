import { createHash } from 'node:crypto';

export function opaqueSessionId(source: string, sessionId: string): string {
  return createHash('sha256').update(source).update('\0').update(sessionId).digest('hex');
}

export function privateWorkspaceId(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  const windowsPath = /^[a-z]:\//i.test(normalized) || normalized.startsWith('//');
  const hashInput = windowsPath ? normalized.toLowerCase() : normalized;
  const fingerprint = createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
  return `workspace://${fingerprint}`;
}
