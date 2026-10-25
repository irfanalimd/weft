// Everything the command palette can do.

import type { App } from './app';
import { relativeTime, shortcut } from './dom';
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

export function buildCommands(app: App): PaletteItem[] {
  const hasDoc = app.hasDoc;
  const items: PaletteItem[] = [
    { id: 'new', label: 'New doc', group: 'Document', icon: 'plus', keywords: 'create blank fresh', run: () => app.newDoc() },
  ];
  if (hasDoc) {
    items.push(
      { id: 'copy-link', label: 'Copy link', group: 'Document', icon: 'link', keywords: 'share url', run: () => void app.copyLink() },
      { id: 'share', label: 'Share…', group: 'Document', icon: 'share', keywords: 'qr code phone', run: () => app.openShare() },
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
    {
      id: 'theme',
      label: app.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      group: 'View',
      icon: app.theme === 'dark' ? 'sun' : 'moon',
      keywords: 'toggle theme dark light appearance mode',
      run: () => app.toggleTheme(),
    },
  );
  if (hasDoc) {
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
  for (const d of listRecent().filter((d) => d.id !== app.currentId).slice(0, 20)) {
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
  return items;
}
