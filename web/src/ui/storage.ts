// localStorage helpers that never throw (private mode, quota, disabled storage).

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// ---------- Recent docs ----------

export interface RecentDoc {
  id: string;
  title: string;
  lastOpened: number;
}

const RECENT_KEY = 'weft:recent';
const RECENT_MAX = 50;

export function listRecent(): RecentDoc[] {
  const list = readJson<RecentDoc[]>(RECENT_KEY, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((d) => d && typeof d.id === 'string' && typeof d.title === 'string')
    .sort((a, b) => b.lastOpened - a.lastOpened);
}

/** Record that a doc was opened/edited. Only docs with content are worth remembering. */
export function touchRecent(id: string, title: string): void {
  const list = listRecent().filter((d) => d.id !== id);
  list.unshift({ id, title, lastOpened: Date.now() });
  writeJson(RECENT_KEY, list.slice(0, RECENT_MAX));
}

export function removeRecent(id: string): void {
  writeJson(
    RECENT_KEY,
    listRecent().filter((d) => d.id !== id),
  );
}
