// Minimal single-range diff (common prefix/suffix trimming), surrogate-pair safe.

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The single edit turning `a` into `b`, or null if they're equal. Positions are UTF-16. */
export function diffText(a: string, b: string): TextEdit | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  // Don't split a surrogate pair: back off if the prefix ends on a high surrogate.
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  // ...or if the suffix starts on a low surrogate.
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}
