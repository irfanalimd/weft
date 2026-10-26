// Shown under the placeholder while a doc is empty: a few hints and your recent docs.

import { h, relativeTime, shortcut } from './dom';
import { docPath } from './router';
import { listRecent } from './storage';

export function renderEmptyState(el: HTMLElement, currentId: string, onOpen: (id: string) => void, showRecent = true): void {
  const recent = (showRecent ? listRecent() : [])
    .filter((d) => d.id !== currentId)
    .slice(0, 6);
  const hint = (code: string, text: string) => h('li', null, h('code', null, code), text);
  el.replaceChildren(
    h(
      'ul',
      { class: 'empty-state__hints', 'aria-label': 'Tips' },
      hint('#', 'Heading'),
      hint('**bold**', 'Bold'),
      hint('- [ ]', 'Task'),
      hint(shortcut('K'), 'Commands'),
    ),
    recent.length
      ? h(
          'nav',
          { 'aria-label': 'Recent documents' },
          h('h2', { class: 'empty-state__heading' }, 'Recent'),
          h(
            'ul',
            { class: 'recent-list' },
            ...recent.map((d) =>
              h(
                'li',
                null,
                h(
                  'a',
                  {
                    href: docPath(d.id),
                    onclick: (e: MouseEvent) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let new-tab clicks through
                      e.preventDefault();
                      onOpen(d.id);
                    },
                  },
                  h('span', { class: 'recent-list__title' }, d.title || 'Untitled'),
                  h('span', { class: 'recent-list__when' }, relativeTime(d.lastOpened)),
                ),
              ),
            ),
          ),
        )
      : '',
  );
}
