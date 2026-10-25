// CodeMirror 6 collaborative binding + remote cursor decorations.
//
// Local transactions -> CRDT insert/delete (via CollabHost). Remote changes are dispatched with
// the `remoteEdit` annotation so the plugin doesn't echo them back, and with addToHistory=false
// so Ctrl+Z only undoes your own edits.
//
// DOM / CSS contract for restyling (owner D may override in their theme):
//   .weft-remote-selection   mark over a peer's selected range
//   .weft-remote-cursor      zero-width caret widget at a peer's cursor head
//                            attrs: data-client-id, data-name
//   .weft-remote-label       name tag inside the caret (absolutely positioned above it)
//   --weft-peer-color        CSS variable set inline on all of the above to the peer's color
// Minimal defaults ship via EditorView.baseTheme below (lowest precedence, easy to override).

import {
  Annotation,
  ChangeSet,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { ChangeJs } from './wasm';
import { diffText } from './diff';
import { PALETTE } from './identity';

/** Marks transactions that came from the CRDT (remote peers, other tabs, restores of state). */
export const remoteEdit = Annotation.define<boolean>();

/** A single local edit in CRDT terms: delete `del` units at `pos`, then insert `text` there. */
export interface LocalEdit {
  pos: number;
  del: number;
  text: string;
}

export interface CollabHost {
  /** Current CRDT text, or null once the session is destroyed. */
  text(): string | null;
  /** Apply local edits to the CRDT, in order (each relative to the result of the previous). */
  applyLocal(edits: LocalEdit[], origin: EditorView): void;
  /** The local selection or focus changed; the host reads it lazily (throttled). */
  selectionChanged(view: EditorView): void;
  attach(view: EditorView): void;
  detach(view: EditorView): void;
}

export interface RemoteCursor {
  clientId: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

/** Build a transaction spec applying sequential CRDT changes to `state`. Null if no-op. */
export function remoteChangesSpec(
  state: EditorState,
  changes: ChangeJs[],
  expectedText: () => string,
  expectedLen: number,
): TransactionSpec | null {
  let cs = ChangeSet.empty(state.doc.length);
  let ok = true;
  try {
    for (const c of changes) {
      const len = cs.newLength;
      const next =
        'insert' in c
          ? ChangeSet.of({ from: c.insert.pos, insert: c.insert.text }, len)
          : ChangeSet.of({ from: c.delete.pos, to: c.delete.pos + c.delete.len }, len);
      cs = cs.compose(next);
    }
  } catch {
    ok = false; // out-of-range change: editor and CRDT disagree
  }
  if (!ok || cs.newLength !== expectedLen) {
    // Self-heal: replace the differing range with the CRDT's text.
    console.warn('[weft] editor/CRDT mismatch; resyncing editor text');
    const edit = diffText(state.doc.toString(), expectedText());
    if (!edit) return null;
    cs = ChangeSet.of(edit, state.doc.length);
  }
  if (cs.empty) return null;
  return {
    changes: cs,
    annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)],
  };
}

function collabPlugin(host: CollabHost) {
  return ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        host.attach(view);
        // The editor may have been created from a slightly stale getText(); reconcile.
        queueMicrotask(() => {
          const text = host.text();
          const edit = text === null ? null : diffText(view.state.doc.toString(), text);
          if (edit) {
            view.dispatch({
              changes: edit,
              annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)],
            });
          }
        });
      }

      update(u: ViewUpdate) {
        for (const tr of u.transactions) {
          if (!tr.docChanged || tr.annotation(remoteEdit)) continue;
          // iterChanges reports ranges in the *old* doc in ascending order. Applying them in
          // reverse keeps earlier positions valid without offset bookkeeping.
          const edits: LocalEdit[] = [];
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            edits.push({ pos: fromA, del: toA - fromA, text: inserted.toString() });
          });
          edits.reverse();
          host.applyLocal(edits, this.view);
        }
        const local = u.transactions.some((tr) => !tr.annotation(remoteEdit) && (tr.selection || tr.docChanged));
        if (local || u.focusChanged) host.selectionChanged(this.view);
      }

      destroy() {
        host.detach(this.view);
      }
    },
  );
}

// Peer names/colors arrive from untrusted awareness payloads. Colors end up in inline styles,
// so only `#rrggbb` is accepted; names are only ever set via textContent / attributes.
const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_NAME = 40;

/** A palette color picked deterministically from `key` (e.g. a client id). */
export const paletteColor = (key: string): string => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/** `c` if it is `#rrggbb`, else `fallback` (itself validated), else a palette color. */
export const safeColor = (c: unknown, fallback?: string): string => {
  if (typeof c === 'string' && SAFE_COLOR.test(c.trim())) return c.trim();
  if (fallback !== undefined && SAFE_COLOR.test(fallback)) return fallback;
  return PALETTE[0];
};

/** Trimmed, control characters stripped, at most 40 code points; `fallback` if empty. */
export const safeName = (n: unknown, fallback: string): string => {
  if (typeof n !== 'string') return fallback;
  // Strips C0/C1 controls plus bidi overrides/isolates and zero-width chars that could spoof.
  const cleaned = n.replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, '').trim();
  const name = Array.from(cleaned).slice(0, MAX_NAME).join('').trim();
  return name || fallback;
};

class CaretWidget extends WidgetType {
  constructor(
    readonly clientId: string,
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  eq(o: CaretWidget) {
    return o.clientId === this.clientId && o.name === this.name && o.color === this.color;
  }
  toDOM() {
    const caret = document.createElement('span');
    caret.className = 'weft-remote-cursor';
    caret.style.setProperty('--weft-peer-color', this.color);
    caret.dataset.clientId = this.clientId;
    caret.dataset.name = this.name;
    caret.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'weft-remote-label';
    label.textContent = this.name;
    caret.append('⁠', label, '⁠');
    return caret;
  }
  ignoreEvent() {
    return true;
  }
}

function buildCursors(cursors: RemoteCursor[], len: number): DecorationSet {
  const clamp = (n: number) => Math.max(0, Math.min(len, n));
  const ranges = [];
  for (const c of cursors) {
    const anchor = clamp(c.anchor);
    const head = clamp(c.head);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    const color = safeColor(c.color, paletteColor(c.clientId));
    const name = safeName(c.name, 'Anonymous');
    const style = `--weft-peer-color: ${color}`;
    if (from < to) {
      ranges.push(
        Decoration.mark({
          class: 'weft-remote-selection',
          attributes: { style, 'data-client-id': c.clientId },
        }).range(from, to),
      );
    }
    ranges.push(
      Decoration.widget({ widget: new CaretWidget(c.clientId, name, color), side: 1 }).range(
        head,
      ),
    );
  }
  return Decoration.set(ranges, true);
}

export const remoteCursorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setRemoteCursors)) return buildCursors(e.value, tr.state.doc.length);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const baseTheme = EditorView.baseTheme({
  '.weft-remote-selection': {
    backgroundColor: 'color-mix(in srgb, var(--weft-peer-color) 24%, transparent)',
  },
  '.weft-remote-cursor': {
    position: 'relative',
    borderLeft: '2px solid var(--weft-peer-color)',
    marginLeft: '-1px',
    marginRight: '-1px',
    pointerEvents: 'none',
  },
  '.weft-remote-label': {
    position: 'absolute',
    bottom: '100%',
    left: '-2px',
    padding: '0 4px',
    borderRadius: '3px 3px 3px 0',
    background: 'var(--weft-peer-color)',
    color: '#fff',
    font: '600 11px/1.5 system-ui, sans-serif',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    pointerEvents: 'none',
    zIndex: '10',
  },
});

export function collabExtension(host: CollabHost): Extension[] {
  return [
    // Only "\n" separates lines, so "\r" from non-CodeMirror peers keeps UTF-16 lengths in step.
    EditorState.lineSeparator.of('\n'),
    collabPlugin(host),
    remoteCursorsField,
    baseTheme,
  ];
}
