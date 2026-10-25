// Small fuzzy matcher: subsequence match with bonuses for word starts and runs.

export interface FuzzyMatch {
  score: number;
  /** Indices into the target string of matched characters (for highlighting). */
  indices: number[];
}

const isBoundary = (s: string, i: number) => {
  if (i === 0) return true;
  const prev = s[i - 1];
  const cur = s[i];
  return /[\s\-_/.:·]/.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
};

export function fuzzy(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, indices: [] };
  const t = target.toLowerCase();
  let best: FuzzyMatch | null = null;
  // Try each occurrence of the first query char as a starting point; keep the best.
  for (let start = t.indexOf(q[0]); start !== -1; start = t.indexOf(q[0], start + 1)) {
    const indices: number[] = [];
    let score = 0;
    let ti = start;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      // Prefer a boundary match ahead over the next plain occurrence.
      let found = -1;
      for (let j = ti; j < t.length; j++) {
        if (t[j] !== q[qi]) continue;
        if (found === -1) found = j;
        if (j === prev + 1) {
          found = j;
          break;
        }
        if (isBoundary(target, j)) {
          found = j;
          break;
        }
      }
      if (found === -1) {
        indices.length = 0;
        break;
      }
      score += 1;
      if (found === prev + 1) score += 6;
      if (isBoundary(target, found)) score += 8;
      if (found === 0) score += 6;
      score -= Math.min(4, found - prev - 1) * 0.5;
      indices.push(found);
      prev = found;
      ti = found + 1;
    }
    if (indices.length === q.length) {
      score -= target.length * 0.02; // shorter labels win ties
      if (!best || score > best.score) best = { score, indices: indices.slice() };
    }
    if (start > 64) break; // long strings: good enough
  }
  return best;
}
