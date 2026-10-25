// Undo/redo wiring, isolated so the CRDT-aware undo from src/sync can replace it in one place.
//
// Today this is CodeMirror's own history. Remote changes are dispatched with
// Transaction.addToHistory.of(false) by the collab binding, so only local edits are undone.

import { history, historyKeymap } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';

export function undoExtensions(): Extension {
  return [history(), keymap.of(historyKeymap)];
}
