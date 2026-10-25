// Export: download .md, and Markdown -> HTML using the same Lezer parser the editor uses.

import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';

export function downloadMarkdown(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy rendered HTML (rich) plus the HTML source as plain text. */
export async function copyHtml(markdown: string): Promise<void> {
  const html = markdownToHtml(markdown);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([html], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      /* fall through to plain text */
    }
  }
  await copyText(html);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Older browsers / insecure origins: the textarea trick.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Clipboard unavailable');
  }
}

// ---------- Markdown -> HTML ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
const safeUrl = (u: string) => (/^\s*(javascript|vbscript|data):/i.test(u) ? '#' : u.trim());

const MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'QuoteMark',
  'ListMark',
  'StrikethroughMark',
  'TableDelimiter',
  'CodeInfo',
  'LinkTitle',
  'LinkLabel',
  'Comment',
  'ProcessingInstruction',
]);

export function markdownToHtml(src: string): string {
  const tree = markdownLanguage.parser.parse(src);
  const text = (n: { from: number; to: number }) => src.slice(n.from, n.to);

  function children(node: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
    return out;
  }

  /** Inline content of `node` between `from` and `to`, skipping markup. */
  function inline(node: SyntaxNode, from = node.from, to = node.to): string {
    let out = '';
    let pos = from;
    for (const c of children(node)) {
      if (c.to <= from || c.from >= to) continue;
      if (c.from > pos) out += esc(src.slice(pos, c.from));
      if (!MARKS.has(c.name)) out += renderInline(c);
      pos = Math.max(pos, c.to);
    }
    if (pos < to) out += esc(src.slice(pos, to));
    return out;
  }

  function renderInline(n: SyntaxNode): string {
    switch (n.name) {
      case 'Emphasis':
        return `<em>${inline(n)}</em>`;
      case 'StrongEmphasis':
        return `<strong>${inline(n)}</strong>`;
      case 'Strikethrough':
        return `<del>${inline(n)}</del>`;
      case 'InlineCode': {
        const marks = children(n).filter((c) => c.name === 'CodeMark');
        const from = marks[0]?.to ?? n.from;
        const to = marks.length > 1 ? marks[marks.length - 1].from : n.to;
        return `<code>${esc(src.slice(from, to).replace(/^ (.+) $/, '$1'))}</code>`;
      }
      case 'Link':
      case 'Image': {
        const marks = children(n).filter((c) => c.name === 'LinkMark');
        const url = n.getChild('URL');
        const labelFrom = marks[0]?.to ?? n.from;
        const labelTo = marks[1]?.from ?? n.to;
        if (n.name === 'Image') {
          return `<img src="${escAttr(safeUrl(url ? text(url) : ''))}" alt="${escAttr(src.slice(labelFrom, labelTo))}">`;
        }
        const label = inline(n, labelFrom, labelTo);
        return url ? `<a href="${escAttr(safeUrl(text(url)))}">${label}</a>` : label;
      }
      case 'Autolink': {
        const url = n.getChild('URL');
        const u = url ? text(url) : text(n).replace(/^<|>$/g, '');
        const href = /^[^@\s]+@[^@\s]+$/.test(u) && !u.includes(':') ? `mailto:${u}` : u;
        return `<a href="${escAttr(safeUrl(href))}">${esc(u)}</a>`;
      }
      case 'URL': {
        const u = text(n);
        const href = /^www\./i.test(u) ? `https://${u}` : u;
        return `<a href="${escAttr(safeUrl(href))}">${esc(u)}</a>`;
      }
      case 'Escape':
        return esc(text(n).slice(1));
      case 'Entity':
        return text(n);
      case 'HardBreak':
        return '<br>';
      case 'TaskMarker':
        return `<input type="checkbox" disabled${/x/i.test(text(n)) ? ' checked' : ''}> `;
      default:
        return n.firstChild ? inline(n) : esc(text(n));
    }
  }

  function blocks(node: SyntaxNode): string {
    return children(node)
      .filter((c) => !MARKS.has(c.name))
      .map(renderBlock)
      .filter(Boolean)
      .join('\n');
  }

  function renderBlock(n: SyntaxNode): string {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
    if (heading) return `<h${heading[1]}>${inline(n).trim()}</h${heading[1]}>`;
    switch (n.name) {
      case 'Paragraph':
        return `<p>${inline(n).trim()}</p>`;
      case 'Blockquote':
        return `<blockquote>\n${blocks(n)}\n</blockquote>`;
      case 'BulletList':
        return `<ul>\n${blocks(n)}\n</ul>`;
      case 'OrderedList': {
        const first = n.getChild('ListItem')?.getChild('ListMark');
        const start = first ? parseInt(text(first), 10) : 1;
        return `<ol${start !== 1 && !Number.isNaN(start) ? ` start="${start}"` : ''}>\n${blocks(n)}\n</ol>`;
      }
      case 'ListItem': {
        const kids = children(n).filter((c) => !MARKS.has(c.name));
        // Tight items with one paragraph (or a task) render inline, like most Markdown renderers.
        if (kids.length === 1 && (kids[0].name === 'Paragraph' || kids[0].name === 'Task')) {
          return `<li>${inline(kids[0]).trim()}</li>`;
        }
        return `<li>${kids.map((k) => (k.name === 'Task' ? inline(k).trim() : renderBlock(k))).join('\n')}</li>`;
      }
      case 'Task':
        return `<p>${inline(n).trim()}</p>`;
      case 'FencedCode': {
        const info = n.getChild('CodeInfo');
        const lang = info ? text(info).trim().split(/\s+/)[0] : '';
        const code = children(n)
          .filter((c) => c.name === 'CodeText')
          .map(text)
          .join('');
        return `<pre><code${lang ? ` class="language-${escAttr(lang)}"` : ''}>${esc(code)}</code></pre>`;
      }
      case 'CodeBlock': {
        const code = text(n)
          .split('\n')
          .map((l) => l.replace(/^(?: {1,4}|\t)/, ''))
          .join('\n');
        return `<pre><code>${esc(code)}</code></pre>`;
      }
      case 'HorizontalRule':
        return '<hr>';
      case 'HTMLBlock':
        return `<p>${esc(text(n))}</p>`;
      case 'LinkReference':
        return '';
      case 'Table': {
        const rows = children(n).filter((c) => c.name === 'TableHeader' || c.name === 'TableRow');
        const row = (r: SyntaxNode, cell: 'th' | 'td') =>
          `<tr>${children(r)
            .filter((c) => c.name === 'TableCell')
            .map((c) => `<${cell}>${inline(c).trim()}</${cell}>`)
            .join('')}</tr>`;
        const head = rows.filter((r) => r.name === 'TableHeader').map((r) => row(r, 'th'));
        const body = rows.filter((r) => r.name === 'TableRow').map((r) => row(r, 'td'));
        return `<table>\n<thead>${head.join('')}</thead>\n<tbody>${body.join('\n')}</tbody>\n</table>`;
      }
      default:
        return n.firstChild ? blocks(n) : `<p>${esc(text(n))}</p>`;
    }
  }

  return blocks(tree.topNode) + '\n';
}
