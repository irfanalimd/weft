// Routes:
//   /            the Wall (signed in) or the sign-in page
//   /setup       first-run admin setup        /admin   user management (admins)
//   /new         create a note and open it (PWA shortcut)
//   /n/<id>      a private note (16-char base58 id)
//   /d/<slug>    an anonymous doc (ids match the server's ^[A-Za-z0-9_-]{1,64}$); /d alone starts a fresh one

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_ID = /^[1-9A-HJ-NP-Za-km-z]{16}$/;

export type Route =
  | { kind: 'home' }
  | { kind: 'setup' }
  | { kind: 'admin' }
  | { kind: 'new-note' }
  | { kind: 'note'; id: string }
  | { kind: 'doc'; id: string }
  | { kind: 'new-doc' }
  | { kind: 'invalid'; raw: string; what: 'doc' | 'note' }
  | { kind: 'not-found' };

/** A fresh base58 slug (no look-alike characters), from crypto randomness. 10 chars for docs, 16 for notes. */
export function newSlug(len = 10): string {
  let out = '';
  const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 232 = 4 * 58: reject the tail so every character is equally likely.
      if (b < 232 && out.length < len) out += BASE58[b % 58];
    }
  }
  return out;
}

export const newNoteId = (): string => newSlug(16);

function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { kind: 'home' };
  if (path === '/setup') return { kind: 'setup' };
  if (path === '/admin') return { kind: 'admin' };
  if (path === '/new') return { kind: 'new-note' };
  if (path === '/d') return { kind: 'new-doc' };
  const m = /^\/(d|n)\/([^/]*)$/.exec(path);
  if (!m) return { kind: 'not-found' };
  const what = m[1] === 'n' ? 'note' : 'doc';
  const id = decode(m[2]);
  if (id === null || !(what === 'note' ? NOTE_ID : DOC_ID).test(id)) return { kind: 'invalid', raw: id ?? m[2], what };
  return { kind: what, id };
}

/** Keep `?mock…` dev flags across in-app navigation; drop everything else. */
export function withFlags(path: string): string {
  return new URLSearchParams(location.search).has('mock') ? `${path}${location.search}` : path;
}

export function docPath(id: string): string {
  return withFlags(`/d/${id}`);
}

export function notePath(id: string): string {
  return withFlags(`/n/${id}`);
}

export function docUrl(id: string): string {
  return `${location.origin}/d/${id}`;
}

export function noteUrl(id: string): string {
  return `${location.origin}/n/${id}`;
}
