// Live Markdown styling: syntax classes, line decorations for block structure, and task checkboxes.

import { markdownKeymap, markdownLanguage, pasteURLAsLink } from '@codemirror/lang-markdown';
import {
  HighlightStyle,
  Language,
  LanguageDescription,
  LanguageSupport,
  ParseContext,
  defineLanguageFacet,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { Prec, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { parseCode, type MarkdownParser } from '@lezer/markdown';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
  keymap,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { codeLanguages } from './languages';

const highlight = HighlightStyle.define([
  { tag: t.heading, class: 'cm-md-heading' },
  { tag: t.emphasis, class: 'cm-md-em' },
  { tag: t.strong, class: 'cm-md-strong' },
  { tag: t.strikethrough, class: 'cm-md-strike' },
  { tag: t.link, class: 'cm-md-link' },
  { tag: t.url, class: 'cm-md-url' },
  { tag: t.processingInstruction, class: 'cm-md-mark' },
  { tag: t.contentSeparator, class: 'cm-md-mark' },
  { tag: t.labelName, class: 'cm-md-label' },
  // Code inside fenced blocks (nested languages).
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], class: 'tok-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'tok-string' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tok-comment' },
  { tag: [t.number, t.integer, t.float], class: 'tok-number' },
  { tag: [t.bool, t.null, t.atom], class: 'tok-atom' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
]);

// ---------- Task checkboxes ----------

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-task';
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute('aria-label', this.checked ? 'Mark task as not done' : 'Mark task as done');
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

function toggleTaskAt(view: EditorView, markerFrom: number): boolean {
  if (view.state.readOnly) return false;
  const marker = view.state.sliceDoc(markerFrom, markerFrom + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  const done = marker[1] !== ' ';
  view.dispatch({
    changes: { from: markerFrom + 1, to: markerFrom + 2, insert: done ? ' ' : 'x' },
    userEvent: 'input.toggle-task',
  });
  return true;
}

/** Mod-Enter toggles the task on the cursor's line. */
function toggleTaskCommand(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/.exec(line.text);
  if (!m) return false;
  return toggleTaskAt(view, line.from + m[1].length);
}

// ---------- Decorations ----------

const lineDeco = (cls: string) => Decoration.line({ class: cls });
const markDeco = (cls: string) => Decoration.mark({ class: cls });
const headingLine = [1, 2, 3, 4, 5, 6].map((n) => lineDeco(`cm-md-h${n}`));
const quoteLine = lineDeco('cm-md-quote');
const codeLine = lineDeco('cm-md-codeblock');
const codeFirst = lineDeco('cm-md-codeblock cm-md-codeblock-first');
const codeLast = lineDeco('cm-md-codeblock cm-md-codeblock-last');
const codeOnly = lineDeco('cm-md-codeblock cm-md-codeblock-first cm-md-codeblock-last');
const hrLine = lineDeco('cm-md-hr');
const inlineCode = markDeco('cm-md-inline-code');
const listMark = markDeco('cm-md-list-mark');
const taskDone = markDeco('cm-md-task-done');
const taskBox = [false, true].map((checked) => Decoration.replace({ widget: new TaskWidget(checked) }));

interface Pending {
  from: number;
  to: number;
  deco: Decoration;
  line: boolean;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const pending: Pending[] = [];
  const lines = (from: number, to: number, pick: (i: number, n: number) => Decoration) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let i = first; i <= last; i++) {
      const l = state.doc.line(i);
      pending.push({ from: l.from, to: l.from, deco: pick(i - first, last - first + 1), line: true });
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const h = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (h) {
          lines(node.from, node.to, () => headingLine[Number(h[1]) - 1]);
          return;
        }
        switch (name) {
          case 'Blockquote':
            lines(node.from, node.to, () => quoteLine);
            break;
          case 'FencedCode':
          case 'CodeBlock':
            lines(node.from, node.to, (i, n) => (n === 1 ? codeOnly : i === 0 ? codeFirst : i === n - 1 ? codeLast : codeLine));
            break;
          case 'HorizontalRule':
            lines(node.from, node.to, () => hrLine);
            break;
          case 'InlineCode':
            pending.push({ from: node.from, to: node.to, deco: inlineCode, line: false });
            return false;
          case 'ListMark':
            pending.push({ from: node.from, to: node.to, deco: listMark, line: false });
            break;
          case 'TaskMarker': {
            const checked = /x/i.test(state.sliceDoc(node.from + 1, node.from + 2));
            pending.push({ from: node.from, to: node.to, deco: taskBox[checked ? 1 : 0], line: false });
            if (checked) {
              const task = node.node.parent;
              if (task && task.to > node.to + 1) {
                pending.push({ from: node.to + 1, to: task.to, deco: taskDone, line: false });
              }
            }
            break;
          }
        }
      },
    });
  }

  // RangeSetBuilder needs ranges sorted by from, then by startSide (line decorations first).
  pending.sort((a, b) => a.from - b.from || (a.line === b.line ? 0 : a.line ? -1 : 1) || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let prev: Pending | null = null;
  for (const p of pending) {
    // Overlapping visible ranges can report the same node twice; skip exact duplicates.
    if (prev && prev.from === p.from && prev.to === p.to && prev.deco === p.deco) continue;
    builder.add(p.from, p.to, p.deco);
    prev = p;
  }
  return builder.finish();
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = build(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      click(e) {
        // The doc is the source of truth for checkboxes: never let the browser flip one by itself.
        const target = e.target as HTMLElement;
        if (target instanceof HTMLInputElement && target.classList.contains('cm-md-task')) {
          e.preventDefault();
          return true;
        }
        return false;
      },
      mousedown(e, view) {
        const target = e.target as HTMLElement;
        if (target instanceof HTMLInputElement && target.classList.contains('cm-md-task')) {
          e.preventDefault();
          return toggleTaskAt(view, view.posAtDOM(target));
        }
        // Cmd/Ctrl-click opens links.
        if ((e.metaKey || e.ctrlKey) && e.button === 0) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          const url = linkAt(view.state, pos);
          if (url) {
            e.preventDefault();
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
          }
        }
        return false;
      },
    },
  },
);

function linkAt(state: EditorState, pos: number): string | null {
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'URL') return normalizeUrl(state.sliceDoc(n.from, n.to));
    if (n.name === 'Link' || n.name === 'Autolink') {
      const url = n.getChild('URL');
      return url ? normalizeUrl(state.sliceDoc(url.from, url.to)) : null;
    }
  }
  return null;
}

function normalizeUrl(u: string): string | null {
  if (/^\s*(javascript|vbscript|data):/i.test(u)) return null;
  if (/^www\./i.test(u)) return `https://${u}`;
  return u;
}

// GFM Markdown with lazily loaded code-block languages. This mirrors lang-markdown's `markdown()`
// minus its HTML-in-Markdown support, which would pull ~100 KB of HTML/CSS/JS grammars into the
// main bundle for something a notes editor rarely needs.
const codeParser = (info: string) => {
  const found = info ? LanguageDescription.matchLanguageName(codeLanguages, info, true) : null;
  if (!found) return null;
  return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
};

let support: LanguageSupport | null = null;
function weftMarkdown(): LanguageSupport {
  if (!support) {
    const parser = (markdownLanguage.parser as MarkdownParser).configure([parseCode({ codeParser })]);
    const data = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });
    support = new LanguageSupport(new Language(data, parser, [], 'markdown'), [
      pasteURLAsLink,
      Prec.high(keymap.of(markdownKeymap)),
    ]);
  }
  return support;
}

/** Markdown language + live styling. Shared by the main editor and the read-only history preview. */
export function markdownStyling(): Extension {
  return [weftMarkdown(), syntaxHighlighting(highlight), livePreview];
}

export const taskKeymap = keymap.of([{ key: 'Mod-Enter', run: toggleTaskCommand }]);
