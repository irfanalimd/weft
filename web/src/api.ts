// Typed client for the Wall HTTP API (docs/WALL.md). Every call is same-origin with the session cookie;
// state-changing calls send JSON (the server's CSRF check requires `Content-Type: application/json`).
// With `?mock` in the URL, requests go to an in-browser fake (src/dev/mockApi.ts) instead.

export type Role = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface AdminUser extends User {
  disabled: boolean;
  created_at: number;
  note_count: number;
}

export const NOTE_COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface Note {
  id: string;
  title: string;
  preview: string;
  color: NoteColor;
  pinned: boolean;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

export interface AuthStatus {
  setup_required: boolean;
  anonymous_docs: boolean;
  user: User | null;
}

export type NoteFilter = 'all' | 'pinned' | 'archived';
export type NotePatch = Partial<Pick<Note, 'pinned' | 'color' | 'archived'>>;
export type UserPatch = { password?: string; role?: Role; disabled?: boolean };

export const NOTE_ID = /^[1-9A-HJ-NP-Za-km-z]{16}$/;
export const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the server couldn't be reached. */
    readonly status: number,
    message: string,
    /** Seconds from `Retry-After` (429). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get offline(): boolean {
    return this.status === 0;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function waitText(s: number): string {
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 0:
      return "Can't reach the server. Check your connection and try again.";
    case 400:
      return "That didn't look right. Check the fields and try again.";
    case 401:
      return 'Please sign in again.';
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "That doesn't exist anymore.";
    case 409:
      return 'That already exists.';
    case 413:
      return "That's too large.";
    case 429:
      return 'Too many attempts.';
    default:
      return status >= 500 ? 'The server had a problem. Try again in a moment.' : `Request failed (${status}).`;
  }
}

// ---------- transport ----------

type MockHandler = (req: Request) => Promise<Response>;
const mockHandler: Promise<MockHandler> | null = new URLSearchParams(location.search).has('mock')
  ? import('./dev/mockApi').then((m) => m.handle)
  : null;

/** Called on a 401 from an endpoint that needs a session (not login/setup/password checks). */
let unauthorized: (() => void) | null = null;
export function onUnauthorized(cb: () => void): void {
  unauthorized = cb;
}

interface Opts {
  body?: unknown;
  /** Return the body as text instead of JSON. */
  text?: boolean;
  /** Survive page unload (used for deletes flushed on pagehide). */
  keepalive?: boolean;
  /** Don't trigger the global sign-out on 401 (e.g. a wrong current password). */
  quiet401?: boolean;
}

async function call<T>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: opts.text ? 'text/plain, text/markdown' : 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers, cache: 'no-store', keepalive: opts.keepalive };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = opts.body !== undefined ? JSON.stringify(opts.body) : '{}';
  }
  let res: Response;
  try {
    const req = new Request(path, init);
    res = mockHandler ? await (await mockHandler)(req) : await fetch(req);
  } catch {
    throw new ApiError(0, fallbackMessage(0));
  }
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    if (opts.text) return (await res.text()) as T;
    const ct = res.headers.get('Content-Type') ?? '';
    if (!ct.includes('json')) return undefined as T;
    return (await res.json()) as T;
  }
  let message = '';
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j?.error === 'string') message = j.error.trim();
  } catch {
    /* not JSON */
  }
  if (!message) message = fallbackMessage(res.status);
  else message = message[0].toUpperCase() + message.slice(1);
  let retryAfter: number | null = null;
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After'));
    retryAfter = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : null;
    if (retryAfter !== null) message = `${message.replace(/\.?$/, '.')} Try again in ${waitText(retryAfter)}.`;
  }
  if (res.status === 401 && !opts.quiet401) unauthorized?.();
  throw new ApiError(res.status, message, retryAfter);
}

// ---------- validation (server data is rendered, so normalise it) ----------

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function safeNoteColor(v: unknown): NoteColor {
  return (NOTE_COLORS as readonly unknown[]).includes(v) ? (v as NoteColor) : 'default';
}

export function normalizeNote(n: Partial<Note> & { id: string }): Note {
  return {
    id: n.id,
    title: str(n.title, 200),
    preview: str(n.preview, 600),
    color: safeNoteColor(n.color),
    pinned: n.pinned === true,
    archived: n.archived === true,
    created_at: num(n.created_at),
    updated_at: num(n.updated_at),
  };
}

function normalizeUser<U extends User>(u: U): U {
  return { ...u, username: str(u.username, 64), role: u.role === 'admin' ? 'admin' : 'user' };
}

function notes(list: unknown): Note[] {
  if (!Array.isArray(list)) return [];
  return list.filter((n) => n && typeof n.id === 'string' && NOTE_ID.test(n.id)).map(normalizeNote);
}

// ---------- endpoints ----------

export const api = {
  status: async (): Promise<AuthStatus> => {
    const s = await call<AuthStatus>('GET', '/api/auth/status');
    return {
      setup_required: s?.setup_required === true,
      anonymous_docs: s?.anonymous_docs !== false,
      user: s?.user ? normalizeUser(s.user) : null,
    };
  },
  setup: async (token: string, username: string, password: string): Promise<User> =>
    normalizeUser((await call<{ user: User }>('POST', '/api/auth/setup', { body: { token, username, password }, quiet401: true })).user),
  login: async (username: string, password: string): Promise<User> =>
    normalizeUser((await call<{ user: User }>('POST', '/api/auth/login', { body: { username, password }, quiet401: true })).user),
  logout: (): Promise<void> => call('POST', '/api/auth/logout', { quiet401: true }),
  changePassword: (current: string, next: string): Promise<void> =>
    call('POST', '/api/me/password', { body: { current, new: next }, quiet401: true }),

  listNotes: async (filter: NoteFilter = 'all', q = ''): Promise<Note[]> => {
    const qs = new URLSearchParams({ filter });
    if (q.trim()) qs.set('q', q.trim());
    return notes(await call<Note[]>('GET', `/api/notes?${qs}`));
  },
  createNote: async (body: { id: string; text?: string; from_doc?: string }): Promise<Note> =>
    normalizeNote(await call<Note>('POST', '/api/notes', { body })),
  patchNote: async (id: string, patch: NotePatch): Promise<Note> =>
    normalizeNote(await call<Note>('PATCH', `/api/notes/${encodeURIComponent(id)}`, { body: patch })),
  deleteNote: (id: string, keepalive = false): Promise<void> =>
    call('DELETE', `/api/notes/${encodeURIComponent(id)}`, { keepalive }),
  exportNote: (id: string): Promise<string> => call('GET', `/api/notes/${encodeURIComponent(id)}/export.md`, { text: true }),

  listUsers: async (): Promise<AdminUser[]> => {
    const list = await call<AdminUser[]>('GET', '/api/admin/users');
    return Array.isArray(list) ? list.map(normalizeUser) : [];
  },
  createUser: async (username: string, password: string, role: Role): Promise<AdminUser> =>
    normalizeUser(await call<AdminUser>('POST', '/api/admin/users', { body: { username, password, role } })),
  patchUser: async (id: number, patch: UserPatch): Promise<AdminUser> =>
    normalizeUser(await call<AdminUser>('PATCH', `/api/admin/users/${id}`, { body: patch })),
  deleteUser: (id: number): Promise<void> => call('DELETE', `/api/admin/users/${id}`),
};

/** Client-side validation that mirrors the server's rules, for inline errors before a round trip. */
export function checkUsername(u: string): string | null {
  if (!USERNAME.test(u)) return 'Usernames are 3–32 characters: letters, numbers, dot, dash or underscore.';
  return null;
}

export function checkPassword(p: string): string | null {
  if (p.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters.`;
  if (p.length > MAX_PASSWORD) return `Passwords can be at most ${MAX_PASSWORD} characters.`;
  return null;
}
