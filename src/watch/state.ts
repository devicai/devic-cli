import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cross-invocation memory for `watch`.
 *
 * Every `watch` call is a fresh process, so "has anything changed since the
 * last check?" can only be answered from disk. Without it the CLI would report
 * the same picture forever and the copilot would keep polling a dead thread.
 */

const CACHE_DIR = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, 'devic', 'watch')
  : join(homedir(), '.cache', 'devic', 'watch');

/** Records older than this are stale leftovers from abandoned watches. */
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

/** Keep the delta cheap: only the tail of the conversation can produce new items. */
const MAX_SEEN_UIDS = 300;

export interface WatchFingerprint {
  state: string;
  /** Number of messages in `threadContent` (or chat history). */
  messages: number;
  /** Completed/total task signature, e.g. `3/5`. `-` when the API returns no tasks. */
  tasks: string;
  lastMessageUid?: string;
}

export interface WatchRecord {
  version: 1;
  id: string;
  kind: 'thread' | 'chat';
  /** How many times `watch` has been invoked for this id. */
  polls: number;
  firstSeenAt: number;
  updatedAt: number;
  /** Epoch ms of the last invocation that saw a different fingerprint. */
  lastChangeAt: number;
  /** Consecutive invocations that ended with an unchanged fingerprint. */
  unchangedPolls: number;
  /** Epoch ms the thread entered its current state (backend value when available). */
  stateSince: number;
  fingerprint: WatchFingerprint;
  cursor?: string;
  seenMessageUids: string[];
  /** Last known task list, so the next check can name what got completed. */
  tasksSnapshot?: Array<{ title: string; completed: boolean }>;
  /** Diagnostic codes already reported, so the same advice is not repeated verbatim. */
  advicesEmitted: string[];
}

function ensureDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function recordPath(id: string): string {
  // Ids are Mongo ObjectIds / uuids, but never trust them as path segments.
  return join(CACHE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function newWatchRecord(id: string, kind: 'thread' | 'chat', now: number): WatchRecord {
  return {
    version: 1,
    id,
    kind,
    polls: 0,
    firstSeenAt: now,
    updatedAt: now,
    lastChangeAt: now,
    unchangedPolls: 0,
    stateSince: now,
    fingerprint: { state: '', messages: -1, tasks: '-' },
    seenMessageUids: [],
    advicesEmitted: [],
  };
}

/** Returns `null` when there is no usable record — a corrupt file is not an error. */
export function loadWatchRecord(id: string): WatchRecord | null {
  try {
    const raw = readFileSync(recordPath(id), 'utf8');
    const parsed = JSON.parse(raw) as WatchRecord;
    if (parsed?.version !== 1 || parsed.id !== id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveWatchRecord(record: WatchRecord): void {
  try {
    ensureDir();
    const trimmed: WatchRecord = {
      ...record,
      seenMessageUids: record.seenMessageUids.slice(-MAX_SEEN_UIDS),
      advicesEmitted: record.advicesEmitted.slice(-20),
    };
    writeFileSync(recordPath(record.id), JSON.stringify(trimmed), 'utf8');
  } catch {
    // Memory is an optimisation: a read-only cache dir must not break the watch.
  }
}

export function clearWatchRecord(id: string): void {
  try {
    rmSync(recordPath(id), { force: true });
  } catch {
    /* ignore */
  }
}

/** Drops records untouched for over a day. Cheap enough to run on every watch. */
export function pruneWatchRecords(now: number): void {
  try {
    for (const file of readdirSync(CACHE_DIR)) {
      const path = join(CACHE_DIR, file);
      if (now - statSync(path).mtimeMs > MAX_RECORD_AGE_MS) rmSync(path, { force: true });
    }
  } catch {
    /* no cache dir yet */
  }
}

export function fingerprintsEqual(a: WatchFingerprint, b: WatchFingerprint): boolean {
  return (
    a.state === b.state &&
    a.messages === b.messages &&
    a.tasks === b.tasks &&
    a.lastMessageUid === b.lastMessageUid
  );
}
