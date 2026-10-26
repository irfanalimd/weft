// The account menu (avatar on the Wall) and the change-password dialog.

import { api, checkPassword, errorMessage } from '../api';
import { h } from './dom';
import type { Host } from './host';
import { busy, field, formError, openMenu, openModal, showError, type MenuItem } from './modal';
import { initials } from './text';
import { currentTheme, toggleTheme } from './theme';
import { toast } from './toast';

export function openAccountMenu(host: Host, anchor: HTMLElement): void {
  const me = host.me;
  if (!me) return;
  anchor.setAttribute('aria-expanded', 'true');
  const items: MenuItem[] = [
    { label: 'Change password', icon: 'key', run: () => host.changePassword() },
  ];
  if (me.role === 'admin') items.push({ label: 'Admin · users', icon: 'shield', run: () => host.openAdmin() });
  const dark = currentTheme() === 'dark';
  items.push(
    { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? 'sun' : 'moon', run: () => toggleTheme() },
    { label: 'Sign out', icon: 'logout', run: () => host.signOut() },
  );
  openMenu({
    anchor,
    items,
    label: 'Account',
    align: 'end',
    header: h(
      'div',
      { class: 'menu__header menu__header--account' },
      h('span', { class: 'account-btn account-btn--large', 'aria-hidden': 'true' }, initials(me.username)),
      h('span', { class: 'menu__who' }, h('strong', null, me.username), h('span', null, me.role === 'admin' ? 'Admin' : 'Member')),
    ),
    onClose: () => anchor.setAttribute('aria-expanded', 'false'),
  });
}

/** A password input with a show/hide toggle. */
export function passwordInput(autocomplete: 'current-password' | 'new-password', attrs: Record<string, string> = {}): {
  input: HTMLInputElement;
  toggle: HTMLButtonElement;
} {
  const input = h('input', {
    class: 'input',
    type: 'password',
    autocomplete,
    required: true,
    autocapitalize: 'off',
    spellcheck: 'false',
    ...attrs,
  });
  const toggle = h('button', { class: 'btn btn--icon input-toggle', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false' });
  const sync = () => {
    const shown = input.type === 'text';
    toggle.replaceChildren(document.createTextNode(shown ? 'Hide' : 'Show'));
    toggle.setAttribute('aria-pressed', String(shown));
    toggle.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
  };
  toggle.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    sync();
    input.focus();
  });
  sync();
  return { input, toggle };
}

export function changePasswordDialog(host: Host): void {
  const me = host.me;
  if (!me) return;
  // A (visually hidden) username field lets password managers update the right entry.
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.username, readonly: true, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const current = passwordInput('current-password', { name: 'current' });
  const next = passwordInput('new-password', { name: 'new', minlength: '10', maxlength: '256' });
  const err = formError();
  const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Change password');
  const cancel = h('button', { class: 'btn btn--outline', type: 'button' }, 'Cancel');
  const form = h(
    'form',
    { class: 'modal__body', novalidate: true },
    user,
    field('Current password', current.input, current.toggle),
    field('New password', next.input, next.toggle, 'At least 10 characters. Your other devices will be signed out.'),
    err,
    h('div', { class: 'modal__actions' }, cancel, submit),
  );
  const m = openModal({ title: 'Change password', content: form });
  cancel.addEventListener('click', () => m.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = next.input.value;
    if (!current.input.value) return showError(err, 'Enter your current password.');
    const bad = checkPassword(pw);
    if (bad) return showError(err, bad);
    if (pw === current.input.value) return showError(err, 'The new password is the same as the current one.');
    showError(err, null);
    void busy(submit, async () => {
      try {
        await api.changePassword(current.input.value, pw);
        m.close();
        toast('Password changed · other devices were signed out', { icon: 'check' });
      } catch (ex) {
        showError(err, errorMessage(ex));
        current.input.select();
      }
    });
  });
}
