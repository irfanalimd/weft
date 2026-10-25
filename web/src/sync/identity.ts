// Client ids and the local user's display identity.
//
// Client id scheme: a FRESH random u64 for every session (tab / page load), never persisted.
// CRDT ops are identified by (client, clock) with contiguous clocks per client; if two live tabs,
// or a tab restored from a stale IndexedDB snapshot, reused an id they could mint two different
// ops with the same id and replicas would silently diverge. 64 random bits make collisions
// negligible, and the cost (one extra state-vector entry per session) is small.
//
// The friendly name + color ARE persisted per browser (localStorage), so you stay "Swift Otter".

import type { User } from './types';

export function newClientId(): bigint {
  const buf = new BigUint64Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] === 0n);
  return buf[0];
}

const ADJECTIVES = [
  'Swift', 'Quiet', 'Bright', 'Gentle', 'Clever', 'Brave', 'Calm', 'Lucky', 'Merry', 'Nimble',
  'Bold', 'Witty', 'Sunny', 'Misty', 'Golden', 'Silver', 'Cosmic', 'Velvet', 'Amber', 'Jolly',
];
const ANIMALS = [
  'Otter', 'Fox', 'Heron', 'Lynx', 'Panda', 'Robin', 'Badger', 'Falcon', 'Koala', 'Marten',
  'Owl', 'Seal', 'Wren', 'Ibex', 'Gecko', 'Moose', 'Finch', 'Hare', 'Orca', 'Tapir',
];
/** Mid-saturation colors that read well as cursor/selection tints on light and dark themes. */
export const PALETTE = [
  '#7c5cff', '#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594',
  '#0090ff', '#3e63dd', '#d6409f', '#8e4ec6', '#ad7f58', '#46a758',
];

const USER_KEY = 'weft:user';

function pick<T>(xs: readonly T[]): T {
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  return xs[r[0] % xs.length];
}

export function randomUser(): User {
  return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(PALETTE) };
}

export function loadUser(): User {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      const u = JSON.parse(raw) as Partial<User>;
      if (typeof u.name === 'string' && typeof u.color === 'string' && u.name.trim()) {
        return { name: u.name, color: u.color };
      }
    }
  } catch {
    /* storage blocked or corrupt: fall through */
  }
  const u = randomUser();
  saveUser(u);
  return u;
}

export function saveUser(u: User): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify({ name: u.name, color: u.color }));
  } catch {
    /* ignore */
  }
}
