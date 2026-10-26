// Everything the command palette can do.

import type { App } from './app';
import { relativeTime, shortcut } from './dom';
import type { Host } from './host';
import type { PaletteItem } from './palette';
import { listRecent } from './storage';

export const USER_COLORS = [
  { name: 'Indigo', color: '#5b5bd6' },
  { name: 'Blue', color: '#0091ff' },
  { name: 'Teal', color: '#12a594' },
  { name: 'Green', color: '#30a46c' },
  { name: 'Amber', color: '#e2a336' },
  { name: 'Orange', color: '#f76b15' },
  { name: 'Red', color: '#e5484d' },
  { name: 'Pink', color: '#d6409f' },
  { name: 'Purple', color: '#8e4ec6' },
  { name: 'Slate', color: '#6f6e77' },
];

export function colorItems(current: string, pick: (color: string) => void): PaletteItem[] {
  return USER_COLORS.map((c) => ({
    id: `color-${c.name}`,
    label: c.name,
    swatch: c.color,
    hint: c.color.toLowerCase() === current.toLowerCase() ? 'Current' : undefined,
    run: () => pick(c.color),
  }));
}

/** Commands that exist everywhere once you're signed in: notes, navigation, account. */
export function accountCommands(host: Host, where: 'wall' | 'editor' | 'admin'): PaletteItem[] {
  const items: PaletteItem[] = [];
  const me = host.me;
  if (me) {
    items.push(
      { id: 'new-note', label: 'New note', group: 'Notes', icon: 'plus', keywords: 'create write take compose', run: () => host.newNote() },
      { id: 'search-notes', label: 'Search notes', group: 'Notes', icon: 'search', keywords: 'find full text', run: () => host.goWall({ search: true }) },
    );
    if (where !== 'wall') {
      items.push({ id: 'go-wall', label: 'Go to wall', group: 'Notes', icon: 'wall', keywords: 'home notes back list', run: () => host.goWall() });
    }
  }
  if (host.anonymousDocs) {
    items.push({ id: 'new', label: me ? 'New temporary doc' : 'New doc', group: me ? 'Notes' : 'Document', icon: 'doc', keywords: 'create blank fresh anonymous share', run: () => host.newTempDoc() });
  }
  if (me) {
    if (me.role === 'admin' && where !== 'admin') {
      items.push({ id: 'admin', label: 'Admin · manage users', group: 'Account', icon: 'shield', keywords: 'users accounts admin', run: () => host.openAdmin() });
    }
    items.push(
      { id: 'password', label: 'Change password', group: 'Account', icon: 'key', keywords: 'security account', run: () => host.changePassword() },
      { id: 'signout', label: 'Sign out', group: 'Account', icon: 'logout', keywords: 'log out logout leave', run: () => host.signOut() },
    );
  }
  return items;
}

export function noteItems(host: Host, exclude: string | null): PaletteItem[] {
  return host
    .recentNotes()
    .filter((n) => n.id !== exclude)
    .slice(0, 30)
    .map((n) => ({
      id: `note-${n.id}`,
      label: n.title || n.preview.split('\n', 1)[0] || 'Untitled note',
      group: 'Your notes',
      icon: 'doc' as const,
      hint: relativeTime(n.updated_at),
      keywords: `open note ${n.preview.slice(0, 120)}`,
      run: () => host.navigate(`/n/${n.id}`),
    }));
}

export function themeItem(theme: 'light' | 'dark', toggle: () => void): PaletteItem {
  return {
    id: 'theme',
    label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    group: 'View',
    icon: theme === 'dark' ? 'sun' : 'moon',
    keywords: 'toggle theme dark light appearance mode',
    run: toggle,
  };
}

const GROUP_ORDER = ['Notes', 'Document', 'View', 'You', 'People here', 'Account', 'Your notes', 'Recent'];

/** Stable-sort by group so each group header appears once, in a sensible order. */
export function byGroup(items: PaletteItem[]): PaletteItem[] {
  const rank = (g?: string) => {
    const i = GROUP_ORDER.indexOf(g ?? '');
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it.group) - rank(b.it.group) || a.i - b.i).map((x) => x.it);
}

export function buildCommands(app: App): PaletteItem[] {
  const hasDoc = app.hasDoc;
  const note = app.currentKind === 'note';
  const items: PaletteItem[] = accountCommands(app.host, 'editor');
  if (app.canSaveToWall) {
    items.unshift({ id: 'save-wall', label: 'Save to my wall', group: 'Document', icon: 'bookmark', keywords: 'copy keep private note', run: () => app.saveToWallCommand() });
  }
  if (hasDoc) {
    items.push({ id: 'copy-link', label: 'Copy link', group: 'Document', icon: 'link', keywords: 'share url', run: () => void app.copyLink() });
    if (!note) items.push({ id: 'share', label: 'Share…', group: 'Document', icon: 'share', keywords: 'qr code phone', run: () => app.openShare() });
    items.push(
      { id: 'export-md', label: 'Export as Markdown (.md)', group: 'Document', icon: 'download', keywords: 'download save file', run: () => app.exportMarkdown() },
      { id: 'copy-html', label: 'Copy as HTML', group: 'Document', icon: 'code', keywords: 'clipboard rich paste', run: () => void app.copyAsHtml() },
      { id: 'history', label: 'Open history', group: 'Document', icon: 'history', keywords: 'time travel versions replay restore undo', run: () => app.openHistory() },
    );
  }
  items.push(
    {
      id: 'focus',
      label: app.isFocusMode ? 'Exit focus mode' : 'Focus mode',
      group: 'View',
      icon: 'focus',
      hint: shortcut('F', { shift: true }),
      keywords: 'zen distraction dim paragraph',
      run: () => app.toggleFocus(),
    },
    themeItem(app.theme, () => app.toggleTheme()),
  );
  if (hasDoc && !note) {
    items.push(
      { id: 'rename', label: 'Rename yourself', group: 'You', icon: 'user', keywords: 'name identity profile', run: () => { app.rename(); return false; } },
      { id: 'color', label: 'Change your color', group: 'You', icon: 'palette', keywords: 'cursor colour', run: () => { app.changeColor(); return false; } },
      { id: 'shuffle', label: 'Shuffle name & color', group: 'You', icon: 'user', keywords: 'random identity', run: () => app.shuffleIdentity() },
    );
    for (const p of app.peers) {
      if (p.isSelf) continue;
      items.push({
        id: `peer-${p.clientId}`,
        label: `Go to ${p.name}`,
        group: 'People here',
        swatch: p.color,
        keywords: 'jump cursor collaborator',
        run: () => app.jumpTo(p),
      });
    }
  }
  items.push(...noteItems(app.host, note ? app.currentId : null));
  for (const d of listRecent().filter((d) => d.id !== app.currentId).slice(0, app.host.me ? 8 : 20)) {
    items.push({
      id: `recent-${d.id}`,
      label: d.title || 'Untitled',
      group: 'Recent',
      icon: 'doc',
      hint: relativeTime(d.lastOpened),
      keywords: `open recent ${d.id}`,
      run: () => app.goTo(d.id),
    });
  }
  return byGroup(items);
}
