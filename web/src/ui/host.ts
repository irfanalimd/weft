// What views (editor, Wall, admin) can ask of the app shell. Implemented by Shell (shell.ts).

import type { Note, User } from '../api';

export interface Host {
  /** The signed-in user, or null. */
  readonly me: User | null;
  /** Whether this server allows anonymous /d/ docs. */
  readonly anonymousDocs: boolean;
  navigate(path: string, opts?: { replace?: boolean }): void;
  /** Create a note and open it, ready to type. Call from a user gesture so phones show the keyboard. */
  newNote(): void;
  newTempDoc(): void;
  goWall(opts?: { search?: boolean }): void;
  openAdmin(): void;
  changePassword(): void;
  signOut(): void;
  /** Copy an anonymous doc into a new private note, then open it. */
  saveDocToWall(slug: string): void;
  /** Make sure a just-created note exists on the server before its socket opens. */
  beforeOpenNote(id: string): Promise<void>;
  /** Fresh text from the editor, for the Wall card. */
  noteEdited(id: string, text: string): void;
  /** The server refused a note's socket. Returns true if the shell recovered (the editor should retry). */
  noteRefused(id: string, status: 401 | 403 | 404): Promise<boolean>;
  /** Notes for the palette's "open" list (cached, most recent first). */
  recentNotes(): Note[];
  /** A hidden input focused during the tap that created a note; holds anything typed before the editor is ready. */
  takeKeyboardBridge(): HTMLInputElement | null;
}
