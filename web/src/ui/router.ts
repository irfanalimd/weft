// Routes: "/" -> new doc, "/d/<id>" -> open doc. Doc ids match the server's ^[A-Za-z0-9_-]{1,64}$.

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Route = { kind: 'doc'; id: string } | { kind: 'new' } | { kind: 'invalid'; raw: string };

/** A fresh 10-character base58 slug (no look-alike characters), from crypto randomness. */
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

export function parseRoute(pathname: string): Route {
  const m = /^\/d\/([^/]*)\/?$/.exec(pathname);
  if (!m) return { kind: 'new' };
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return { kind: 'invalid', raw: m[1] };
  }
  return DOC_ID.test(id) ? { kind: 'doc', id } : { kind: 'invalid', raw: id };
}

/** Path for a doc, keeping the current query string (so ?mock survives navigation). */
export function docPath(id: string): string {
  return `/d/${id}${location.search}`;
}

export function docUrl(id: string): string {
  return `${location.origin}/d/${id}`;
}
