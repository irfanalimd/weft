// Minimal single-range change turning `a` into `b` (common prefix/suffix trim).

export interface SimpleChange {
  from: number;
  to: number;
  insert: string;
}

export function minimalChange(a: string, b: string): SimpleChange | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  // Don't split a surrogate pair.
  if (start > 0 && isHigh(a.charCodeAt(start - 1))) start--;
  if (endA < a.length && isLow(a.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
