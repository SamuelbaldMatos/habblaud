import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, type Dirent } from 'node:fs';
import { isAbsolute as isPosixAbsolute } from 'node:path/posix';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import { join } from 'node:path';

export const CODEX_RECENT_WINDOW_MS = 30 * 60 * 1000;
export const CODEX_MAX_SESSIONS = 20;
export const CODEX_MAX_RECORD_BYTES = 8 * 1024;

const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_CANDIDATE_FILES = 5_000;

export interface CodexSessionMetadata {
  session_id: string;
  cwd: string;
  timestamp: string;
  originator?: string;
  source?: string;
  model_provider?: string;
  modified_at: number;
}

export type CodexMetadataRejectReason =
  | 'directory_unavailable'
  | 'file_unavailable'
  | 'record_too_large'
  | 'malformed_json'
  | 'invalid_record'
  | 'unexpected_record_type'
  | 'invalid_session_id'
  | 'invalid_cwd'
  | 'invalid_timestamp'
  | 'invalid_optional_metadata';

export type CodexMetadataReaderError = 'invalid_options' | 'root_unavailable' | 'scan_limit_exceeded';

export type CodexMetadataReadResult =
  | {
      ok: true;
      sessions: CodexSessionMetadata[];
      rejections: Partial<Record<CodexMetadataRejectReason, number>>;
    }
  | {
      ok: false;
      error: CodexMetadataReaderError;
    };

export interface CodexMetadataReaderOptions {
  recentWindowMs?: number;
  maxSessions?: number;
  now?: number;
}

interface DirectoryRead {
  entries: Dirent[];
  limitExceeded: boolean;
}

interface ScanBudget {
  entries: number;
}

interface Candidate {
  file: string;
  modifiedAt: number;
}

type FirstRecordRead =
  | { line: string; modifiedAt: number }
  | { reject: 'file_unavailable' | 'record_too_large' | 'not_recent' };

function readDirectory(path: string, budget: ScanBudget): DirectoryRead {
  const directory = opendirSync(path);
  const entries: DirectoryRead['entries'] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) return { entries, limitExceeded: false };
      budget.entries++;
      if (budget.entries > MAX_DIRECTORY_ENTRIES) return { entries: [], limitExceeded: true };
      entries.push(entry);
    }
  } finally {
    try {
      directory.closeSync();
    } catch {
      // The directory may already have been closed by the runtime.
    }
  }
}

function isDateFolder(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isAbsoluteCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (isPosixAbsolute(value)) return true;
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!isDateFolder(year, month, day) || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function optionalMetadata(record: Record<string, unknown>, key: 'originator' | 'source' | 'model_provider'): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function parseFirstRecord(line: string, modifiedAt: number): { metadata?: CodexSessionMetadata; reject?: CodexMetadataRejectReason } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return { reject: 'malformed_json' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { reject: 'invalid_record' };
  const record = value as Record<string, unknown>;
  if (record.type !== 'session_meta') return { reject: 'unexpected_record_type' };
  if (
    Object.keys(record).some((key) => key !== 'type' && key !== 'payload')
    || record.payload === null
    || typeof record.payload !== 'object'
    || Array.isArray(record.payload)
  ) return { reject: 'invalid_record' };
  const payload = record.payload as Record<string, unknown>;

  const id = payload.session_id === undefined ? payload.id : payload.session_id;
  if (!isSessionId(id)) return { reject: 'invalid_session_id' };
  if (!isAbsoluteCwd(payload.cwd)) return { reject: 'invalid_cwd' };
  if (!validTimestamp(payload.timestamp)) return { reject: 'invalid_timestamp' };

  const originator = optionalMetadata(payload, 'originator');
  const source = optionalMetadata(payload, 'source');
  const modelProvider = optionalMetadata(payload, 'model_provider');
  if (originator === null || source === null || modelProvider === null) return { reject: 'invalid_optional_metadata' };

  const metadata: CodexSessionMetadata = {
    session_id: id,
    cwd: payload.cwd,
    timestamp: payload.timestamp,
    modified_at: modifiedAt,
  };
  if (originator !== undefined) metadata.originator = originator;
  if (source !== undefined) metadata.source = source;
  if (modelProvider !== undefined) metadata.model_provider = modelProvider;
  return { metadata };
}

function readFirstRecord(file: string, cutoff: number, now: number): FirstRecordRead {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { reject: 'file_unavailable' };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { reject: 'file_unavailable' };
    const modifiedAt = stat.mtimeMs;
    if (!Number.isFinite(modifiedAt) || modifiedAt < cutoff || modifiedAt > now) return { reject: 'not_recent' };

    const bytes = Buffer.alloc(CODEX_MAX_RECORD_BYTES);
    const byte = Buffer.alloc(1);
    let length = 0;
    let foundNewline = false;
    while (length < bytes.length) {
      const count = readSync(fd, byte, 0, 1, length);
      if (count === 0) break;
      if (byte[0] === 0x0a) {
        foundNewline = true;
        break;
      }
      bytes[length++] = byte[0]!;
    }
    if (!foundNewline && stat.size > bytes.length) return { reject: 'record_too_large' };
    let line = bytes.subarray(0, length).toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return { line, modifiedAt };
  } catch {
    return { reject: 'file_unavailable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing a failed read is best-effort; no file contents are retained.
    }
  }
}

function validOptions(options: CodexMetadataReaderOptions): boolean {
  const { recentWindowMs = CODEX_RECENT_WINDOW_MS, maxSessions = CODEX_MAX_SESSIONS, now = Date.now() } = options;
  return Number.isFinite(recentWindowMs) && recentWindowMs >= 0
    && Number.isInteger(maxSessions) && maxSessions >= 1 && maxSessions <= CODEX_MAX_SESSIONS
    && Number.isFinite(now);
}

/**
 * Reads only the first JSONL record from the newest recent Codex rollout files.
 * The record must be a flattened `session_meta` item; no transcript records are returned.
 */
export function readCodexSessionMetadata(
  sessionsRoot: string,
  options: CodexMetadataReaderOptions = {},
): CodexMetadataReadResult {
  if (!validOptions(options)) return { ok: false, error: 'invalid_options' };
  const now = options.now ?? Date.now();
  const cutoff = now - (options.recentWindowMs ?? CODEX_RECENT_WINDOW_MS);
  const maxSessions = options.maxSessions ?? CODEX_MAX_SESSIONS;
  const budget: ScanBudget = { entries: 0 };
  const rejections: Partial<Record<CodexMetadataRejectReason, number>> = {};
  const reject = (reason: CodexMetadataRejectReason): void => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  let years: DirectoryRead;
  try {
    years = readDirectory(sessionsRoot, budget);
  } catch {
    return { ok: false, error: 'root_unavailable' };
  }
  if (years.limitExceeded) return { ok: false, error: 'scan_limit_exceeded' };

  const candidates: Candidate[] = [];
  const yearDirs = years.entries
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const yearEntry of yearDirs) {
    const year = Number(yearEntry.name);
    let months: DirectoryRead;
    try {
      months = readDirectory(join(sessionsRoot, yearEntry.name), budget);
    } catch {
      reject('directory_unavailable');
      continue;
    }
    if (months.limitExceeded) return { ok: false, error: 'scan_limit_exceeded' };
    const monthDirs = months.entries
      .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const monthEntry of monthDirs) {
      const month = Number(monthEntry.name);
      let days: DirectoryRead;
      try {
        days = readDirectory(join(sessionsRoot, yearEntry.name, monthEntry.name), budget);
      } catch {
        reject('directory_unavailable');
        continue;
      }
      if (days.limitExceeded) return { ok: false, error: 'scan_limit_exceeded' };
      const dayDirs = days.entries
        .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name) && isDateFolder(year, month, Number(entry.name)))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const dayEntry of dayDirs) {
        let files: DirectoryRead;
        try {
          files = readDirectory(join(sessionsRoot, yearEntry.name, monthEntry.name, dayEntry.name), budget);
        } catch {
          reject('directory_unavailable');
          continue;
        }
        if (files.limitExceeded) return { ok: false, error: 'scan_limit_exceeded' };
        for (const entry of files.entries) {
          if (!entry.isFile() || !/^rollout-.+\.jsonl$/.test(entry.name)) continue;
          const file = join(sessionsRoot, yearEntry.name, monthEntry.name, dayEntry.name, entry.name);
          try {
            const stat = lstatSync(file);
            if (!stat.isFile() || !Number.isFinite(stat.mtimeMs) || stat.mtimeMs < cutoff || stat.mtimeMs > now) continue;
            if (candidates.length >= MAX_CANDIDATE_FILES) return { ok: false, error: 'scan_limit_exceeded' };
            candidates.push({ file, modifiedAt: stat.mtimeMs });
          } catch {
            reject('file_unavailable');
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.file.localeCompare(b.file));
  const sessions: CodexSessionMetadata[] = [];
  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    if (sessions.length >= maxSessions) break;
    const read = readFirstRecord(candidate.file, cutoff, now);
    if ('reject' in read) {
      if (read.reject !== 'not_recent') reject(read.reject);
      continue;
    }
    const parsed = parseFirstRecord(read.line, read.modifiedAt);
    if (parsed.reject) {
      reject(parsed.reject);
      continue;
    }
    if (!parsed.metadata) continue;
    if (seenIds.has(parsed.metadata.session_id)) {
      reject('invalid_session_id');
      continue;
    }
    seenIds.add(parsed.metadata.session_id);
    sessions.push(parsed.metadata);
  }
  return { ok: true, sessions, rejections };
}
