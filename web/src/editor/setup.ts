// Builds the CodeMirror editor for a doc session, plus a read-only twin for the history preview.

import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { minimalChange } from './diff';
import { flashLine, focusMode } from './focus';
import { markdownStyling, taskKeymap } from './markdown';
import { weftTheme } from './theme';
import { undoExtensions } from './undo';

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  /** Extensions from the session layer (collab binding, remote cursors). */
  sessionExtensions: Extension[];
  placeholder: string;
  onUpdate?: (u: ViewUpdate) => void;
}

export interface EditorHandle {
  view: EditorView;
  setFocusMode(on: boolean): void;
  destroy(): void;
}

function baseExtensions(): Extension[] {
  return [
    weftTheme,
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    indentUnit.of('  '),
    markdownStyling(),
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      autocorrect: 'on',
      autocapitalize: 'sentences',
      'aria-label': 'Document',
      'aria-multiline': 'true',
    }),
  ];
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const focus = new Compartment();
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        baseExtensions(),
        undoExtensions(),
        drawSelection(),
        dropCursor(),
        placeholder(opts.placeholder),
        flashLine,
        focus.of([]),
        taskKeymap,
        keymap.of([...defaultKeymap, indentWithTab]),
        // Session extensions go last at high precedence: the collab binding must see every transaction,
        // and a CRDT-aware undo keymap from src/sync should win over CodeMirror's history.
        Prec.high(opts.sessionExtensions),
        EditorView.updateListener.of((u) => opts.onUpdate?.(u)),
      ],
    }),
  });
  return {
    view,
    setFocusMode(on) {
      view.dispatch({ effects: focus.reconfigure(on ? focusMode() : []) });
    },
    destroy() {
      view.destroy();
    },
  };
}

/** A read-only editor with the same styling, for previewing old versions. */
export function createPreview(parent: HTMLElement): { set(text: string, follow?: boolean): void; destroy(): void } {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false)],
    }),
  });
  return {
    set(text, follow = false) {
      const change = minimalChange(view.state.doc.toString(), text);
      if (!change) return;
      const end = change.from + change.insert.length;
      view.dispatch({
        changes: change,
        effects: follow ? EditorView.scrollIntoView(end, { y: 'nearest', yMargin: 120 }) : [],
      });
    },
    destroy() {
      view.destroy();
    },
  };
}
