// Pure helpers over document text: title, stats, filenames.

const ATX = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

/** Plain-text version of a short Markdown fragment (for titles). */
export function stripInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1')
    .trim();
}

/** Title from the first heading; falls back to the first non-empty line. Null when the doc is blank. */
export function deriveTitle(text: string, max = 80): string | null {
  let fallback: string | null = null;
  let scanned = 0;
  let inFence = false;
  for (const line of text.split('\n', 400)) {
    scanned += line.length;
    if (/^ {0,3}(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = ATX.exec(line);
    if (m) {
      const t = stripInline(m[1]);
      if (t) return clip(t, max);
    }
    if (fallback === null && line.trim()) {
      const t = stripInline(line.replace(/^\s*(?:[-*+>]|\d+[.)]|\[[ xX]\])\s+/, '').replace(/^\s*\[[ xX]\]\s+/, ''));
      if (t && !/^(```|~~~|---+|\*\*\*+)$/.test(t)) fallback = clip(t, max);
    }
    if (scanned > 20000) break;
  }
  return fallback;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/gu;

export function countWords(text: string): number {
  // CJK characters count as one word each; everything else by word runs.
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, ' ') : text;
  let n = 0;
  WORD.lastIndex = 0;
  while (WORD.exec(rest)) n++;
  return n + cjk;
}

export function readingTime(words: number): string {
  if (words === 0) return '';
  const min = Math.max(1, Math.round(words / 230));
  return `${min} min read`;
}

export function fileName(title: string | null): string {
  const base = (title ?? 'untitled')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'untitled'}.md`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(parts[0])[0] + Array.from(parts[parts.length - 1])[0]).toUpperCase();
}
