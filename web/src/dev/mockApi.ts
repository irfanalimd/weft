// An in-browser fake of the Wall HTTP API (docs/WALL.md), enabled with ?mock. State lives in
// localStorage so reloads keep it. Flags: ?mock&fresh resets to first-run (setup required).
// Seeded admin: ali / correct-horse-battery (bootstrap token for setup: "mock-bootstrap-token-0123456789abcdef").

import type { AdminUser, Note, NoteColor, Role, User } from '../api';

interface MUser extends AdminUser {
  password: string;
}
interface MNote extends Note {
  owner: number;
  text: string;
}
interface Db {
  users: MUser[];
  notes: MNote[];
  session: number | null;
  nextUser: number;
}

const KEY = 'weft:mockapi';
const TOKEN = 'mock-bootstrap-token-0123456789abcdef';
const now = Date.now();
const MIN = 60_000;

const SEED_NOTES: [string, NoteColor, boolean, number][] = [
  ['# Groceries\n- oat milk\n- lemons\n- sourdough\n- coffee beans (the good ones)', 'yellow', true, 12 * MIN],
  ['# Trip to Lisbon\nFlights on the 14th. Stay near Alfama, try the pastéis de nata at Manteigaria, sunset at Miradouro da Senhora do Monte.', 'teal', true, 3 * 60 * MIN],
  ['# Book ideas\nA lighthouse keeper who receives letters from the future.\n\nOr: a cartographer mapping a city that rearranges itself every night.', 'purple', false, 40 * MIN],
  ['Call mom about Sunday', 'default', false, 2 * MIN],
  ['# Weft roadmap\n- Wikilinks and backlinks\n- #tags as filter chips\n- Share a note read-only\n- Daily note with ⌘⇧D', 'blue', false, 26 * 60 * MIN],
  ['# Workout\nMon: run 5k\nWed: climbing\nFri: yoga + core', 'green', false, 3 * 24 * 60 * MIN],
  ['# Gift ideas\n- Sam: a nice fountain pen\n- Priya: that ceramics class\n- Dad: vinyl of Kind of Blue', 'pink', false, 5 * 24 * 60 * MIN],
  ['Wifi at the cabin: pinecone-42', 'orange', false, 9 * 24 * 60 * MIN],
  ['# Reading list\nThe Dispossessed · Piranesi · A Psalm for the Wild-Built · The Overstory', 'gray', false, 14 * 24 * 60 * MIN],
  ['# Old apartment checklist\nReturn keys, photos of the walls, forward mail.', 'red', false, 40 * 24 * 60 * MIN],
];

function seed(fresh: boolean): Db {
  if (fresh) return { users: [], notes: [], session: null, nextUser: 1 };
  const admin: MUser = { id: 1, username: 'ali', role: 'admin', disabled: false, created_at: now - 90 * 24 * 60 * MIN, note_count: 0, password: 'correct-horse-battery' };
  const sam: MUser = { id: 2, username: 'sam', role: 'user', disabled: false, created_at: now - 20 * 24 * 60 * MIN, note_count: 0, password: 'sam-password-123' };
  const notes = SEED_NOTES.map(([text, color, pinned, age], i): MNote => ({
    ...meta(text),
    id: `Mock${'ABCDEFGHJK'[i]}aaaaaaaaaaa`,
    owner: 1,
    text,
    color,
    pinned,
    archived: i === 9,
    created_at: now - age - 60 * MIN,
    updated_at: now - age,
  }));
  return { users: [admin, sam], notes, session: null, nextUser: 3 };
}

function meta(text: string): { title: string; preview: string } {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  const title = first < 0 ? '' : lines[first].replace(/^#+\s*/, '').trim().slice(0, 120);
  return { title, preview: lines.slice(first + 1).join('\n').trim().slice(0, 280) };
}

let db: Db = load();

function load(): Db {
  const fresh = new URLSearchParams(location.search).has('fresh');
  if (!fresh) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw) as Db;
    } catch {
      /* reseed */
    }
  }
  const d = seed(fresh);
  save(d);
  return d;
}

function save(d: Db = db): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const err = (status: number, error: string, headers?: Record<string, string>) => json(status, { error }, headers);

const pubUser = (u: MUser): User => ({ id: u.id, username: u.username, role: u.role });
const adminUser = (u: MUser): AdminUser => ({
  ...pubUser(u),
  disabled: u.disabled,
  created_at: u.created_at,
  note_count: db.notes.filter((n) => n.owner === u.id).length,
});
const pubNote = ({ owner: _o, text: _t, ...n }: MNote): Note => n;

let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handle(req: Request): Promise<Response> {
  await sleep(80 + Math.random() * 120);
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const body = method === 'GET' || method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  const me = db.users.find((u) => u.id === db.session && !u.disabled) ?? null;
  const done = (r: Response) => (save(), r);

  if (path === '/api/auth/status') {
    return json(200, { setup_required: db.users.length === 0, anonymous_docs: true, user: me ? pubUser(me) : null });
  }
  if (path === '/api/auth/setup' && method === 'POST') {
    if (db.users.length) return err(403, 'setup is already complete');
    if (body.token !== TOKEN) return err(403, 'invalid bootstrap token');
    const u: MUser = { id: db.nextUser++, username: body.username, password: body.password, role: 'admin', disabled: false, created_at: Date.now(), note_count: 0 };
    db.users.push(u);
    db.session = u.id;
    return done(json(200, { user: pubUser(u) }));
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const u = db.users.find((x) => x.username.toLowerCase() === String(body.username).toLowerCase());
    if (!u || u.password !== body.password || u.disabled) {
      if (++failures >= 5) return err(429, 'too many attempts', { 'Retry-After': '42' });
      return err(401, 'wrong username or password');
    }
    failures = 0;
    db.session = u.id;
    return done(json(200, { user: pubUser(u) }));
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    db.session = null;
    return done(json(204));
  }
  if (!me) return err(401, 'not signed in');

  if (path === '/api/me/password' && method === 'POST') {
    if (body.current !== me.password) return err(403, 'current password is wrong');
    me.password = body.new;
    return done(json(204));
  }

  if (path === '/api/notes' && method === 'GET') {
    const filter = url.searchParams.get('filter') ?? 'all';
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const list = db.notes
      .filter((n) => n.owner === me.id)
      .filter((n) => (filter === 'archived' ? n.archived : filter === 'pinned' ? n.pinned && !n.archived : !n.archived))
      .filter((n) => !q || n.text.toLowerCase().includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
    return json(200, list.map(pubNote));
  }
  if (path === '/api/notes' && method === 'POST') {
    if (db.notes.some((n) => n.id === body.id)) return err(409, 'id already taken');
    let text = typeof body.text === 'string' ? body.text : '';
    if (body.from_doc) text = `# Copied from /d/${body.from_doc}\n`;
    const t = Date.now();
    const n: MNote = { id: body.id, owner: me.id, text, ...meta(text), color: 'default', pinned: false, archived: false, created_at: t, updated_at: t };
    db.notes.push(n);
    return done(json(201, pubNote(n)));
  }
  const nm = /^\/api\/notes\/([^/]+)(\/export\.md)?$/.exec(path);
  if (nm) {
    const n = db.notes.find((x) => x.id === nm[1]);
    if (!n) return err(404, 'no such note');
    if (n.owner !== me.id) return err(403, 'not your note');
    if (nm[2]) return new Response(n.text, { status: 200, headers: { 'Content-Type': 'text/markdown' } });
    if (method === 'PATCH') {
      for (const k of ['pinned', 'archived', 'color'] as const) if (k in body) (n as unknown as Record<string, unknown>)[k] = body[k];
      return done(json(200, pubNote(n)));
    }
    if (method === 'DELETE') {
      db.notes = db.notes.filter((x) => x !== n);
      return done(json(204));
    }
  }

  if (path.startsWith('/api/admin/')) {
    if (me.role !== 'admin') return err(403, 'admins only');
    if (path === '/api/admin/users' && method === 'GET') return json(200, db.users.map(adminUser));
    if (path === '/api/admin/users' && method === 'POST') {
      if (db.users.some((u) => u.username.toLowerCase() === String(body.username).toLowerCase())) return err(409, 'username is taken');
      const u: MUser = { id: db.nextUser++, username: body.username, password: body.password, role: body.role as Role, disabled: false, created_at: Date.now(), note_count: 0 };
      db.users.push(u);
      return done(json(201, adminUser(u)));
    }
    const um = /^\/api\/admin\/users\/(\d+)$/.exec(path);
    const u = um ? db.users.find((x) => x.id === Number(um[1])) : undefined;
    if (!u) return err(404, 'no such user');
    const admins = db.users.filter((x) => x.role === 'admin' && !x.disabled);
    if (method === 'PATCH') {
      const demoting = (body.role === 'user' || body.disabled === true) && u.role === 'admin';
      if (demoting && admins.length <= 1) return err(409, "can't remove the last admin");
      if ('role' in body) u.role = body.role;
      if ('disabled' in body) u.disabled = body.disabled;
      if ('password' in body) u.password = body.password;
      return done(json(200, adminUser(u)));
    }
    if (method === 'DELETE') {
      if (u.id === me.id) return err(409, "you can't delete yourself");
      db.users = db.users.filter((x) => x !== u);
      db.notes = db.notes.filter((n) => n.owner !== u.id);
      return done(json(204));
    }
  }
  return err(404, 'not found');
}
