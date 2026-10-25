// The CodeMirror theme: layout of the writing surface, driven by the CSS tokens.

import { EditorView } from '@codemirror/view';

export const weftTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--text-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-text)',
    lineHeight: 'var(--text-leading)',
    overflow: 'visible',
  },
  '.cm-content': {
    maxWidth: 'var(--measure)',
    margin: '0 auto',
    padding: '0 0 8px',
    caretColor: 'var(--accent)',
    fontFamily: 'var(--font-text)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftWidth: '2px',
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: 'var(--selection) !important',
    },
  '.cm-placeholder': {
    color: 'var(--text-3)',
    fontStyle: 'normal',
  },
  '.cm-gutters': { display: 'none' },
});
