// Focus mode (dim everything but the paragraph being written) and a "flash this line" effect.

import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

const dim = Decoration.line({ class: 'cm-dim' });

/** Line range [first, last] of the block (lines between blank lines) around the cursor. */
function currentBlock(state: EditorState): [number, number] {
  const doc = state.doc;
  const here = doc.lineAt(state.selection.main.head).number;
  const blank = (n: number) => doc.line(n).text.trim() === '';
  if (blank(here)) return [here, here];
  let first = here;
  let last = here;
  while (first > 1 && !blank(first - 1)) first--;
  while (last < doc.lines && !blank(last + 1)) last++;
  return [first, last];
}

function build(view: EditorView): DecorationSet {
  const [first, last] = currentBlock(view.state);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.number < first || line.number > last) builder.add(line.from, line.from, dim);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function focusMode(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------- Flash a line (used when jumping to a collaborator) ----------

const flashEffect = StateEffect.define<{ pos: number; color: string } | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      if (e.value === null) {
        deco = Decoration.none;
      } else {
        const line = tr.state.doc.lineAt(Math.min(e.value.pos, tr.state.doc.length));
        deco = Decoration.set([
          Decoration.line({
            class: 'cm-flash-line',
            attributes: { style: `--flash: color-mix(in srgb, ${e.value.color} 18%, transparent)` },
          }).range(line.from),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const flashLine: Extension = flashField;

let flashTimer = 0;
export function scrollToAndFlash(view: EditorView, pos: number, color: string): void {
  const p = Math.max(0, Math.min(pos, view.state.doc.length));
  view.dispatch({ effects: [EditorView.scrollIntoView(p, { y: 'center' }), flashEffect.of({ pos: p, color })] });
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: flashEffect.of(null) });
  }, 1500);
}
