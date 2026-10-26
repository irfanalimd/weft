// /admin: create accounts, reset passwords, disable/enable, promote, delete. Admins only.

import { api, checkPassword, checkUsername, errorMessage, type AdminUser, type Role } from '../api';
import { openAccountMenu } from './account';
import { h, relativeTime } from './dom';
import { copyText } from './exportDoc';
import type { Host } from './host';
import { icon } from './icons';
import { busy, confirmDialog, field, formError, openMenu, openModal, showError, type MenuItem } from './modal';
import { initials } from './text';
import { toast } from './toast';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random, readable password: four groups of five (about 116 bits). */
export function generatePassword(): string {
  const out: string[] = [];
  const buf = new Uint8Array(64);
  crypto.getRandomValues(buf);
  while (out.length < 20) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 224 = 4 * 56: reject the tail so every character is equally likely.
      if (b < 224 && out.length < 20) out.push(ALPHABET[b % 56]);
    }
  }
  return [0, 5, 10, 15].map((i) => out.slice(i, i + 5).join('')).join('-');
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyText(text);
    toast(`${what} copied`, { icon: 'check' });
  } catch {
    toast("Couldn't access the clipboard");
  }
}

/** Password field + Generate + Copy buttons. */
function newPasswordRow(initial = ''): { input: HTMLInputElement; row: HTMLElement } {
  const input = h('input', {
    class: 'input input--mono',
    type: 'text',
    autocomplete: 'new-password',
    autocapitalize: 'off',
    spellcheck: 'false',
    minlength: '10',
    maxlength: '256',
    required: true,
    value: initial,
  });
  const gen = h('button', { class: 'btn btn--outline', type: 'button', 'data-tip': 'Generate a strong password' }, icon('sparkle'), h('span', { class: 'hide-narrow' }, 'Generate'));
  const cp = h('button', { class: 'btn btn--outline btn--icon', type: 'button', 'aria-label': 'Copy password', 'data-tip': 'Copy' }, icon('copy'));
  gen.addEventListener('click', () => {
    input.value = generatePassword();
    input.dispatchEvent(new Event('input'));
  });
  cp.addEventListener('click', () => {
    if (input.value) void copy(input.value, 'Password');
  });
  return { input, row: h('div', { class: 'field__buttons' }, gen, cp) };
}

export class AdminView {
  readonly el: HTMLElement;
  private users: AdminUser[] = [];
  private list = h('ul', { class: 'users', 'aria-label': 'People' });
  private count = h('span', { class: 'panel__count' });
  private listError = formError();
  private created = h('div', { class: 'created', hidden: true, role: 'status' });

  constructor(private host: Host) {
    const back = h('button', { class: 'btn back-btn', type: 'button', onclick: () => host.goWall() }, icon('arrowLeft'), h('span', null, 'Wall'));
    const avatar = h('button', { class: 'account-btn', type: 'button', 'aria-label': 'Account', 'aria-haspopup': 'menu' }, initials(host.me?.username ?? '?'));
    avatar.addEventListener('click', () => openAccountMenu(host, avatar));

    this.el = h(
      'div',
      { class: 'page' },
      h('header', { class: 'page-top' }, back, h('h1', { class: 'page-top__title' }, 'Admin'), h('span', { class: 'page-top__spacer' }), avatar),
      h(
        'main',
        { class: 'page-main', id: 'main' },
        h('section', { class: 'panel' }, h('h2', { class: 'panel__title' }, 'Add a person'), h('p', { class: 'panel__sub' }, 'They sign in with this username and password, then can change the password from their account menu.'), this.createForm(), this.created),
        h('section', { class: 'panel' }, h('h2', { class: 'panel__title' }, 'People', this.count), this.listError, this.list),
      ),
    );
  }

  mount(): void {
    document.title = 'Admin · Weft';
    void this.load();
  }

  unmount(): void {}

  private async load(): Promise<void> {
    try {
      this.users = await api.listUsers();
      showError(this.listError, null);
    } catch (e) {
      showError(this.listError, errorMessage(e));
    }
    this.render();
  }

  private createForm(): HTMLElement {
    const username = h('input', { class: 'input', type: 'text', name: 'new-username', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, minlength: '3', maxlength: '32' });
    const pw = newPasswordRow();
    const role = h('select', { class: 'input select', name: 'role' }, h('option', { value: 'user' }, 'Member'), h('option', { value: 'admin' }, 'Admin'));
    const err = formError();
    const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, icon('plus'), 'Create account');
    const form = h(
      'form',
      { class: 'admin-create', novalidate: true },
      h('div', { class: 'admin-create__grid' }, field('Username', username), field('Initial password', pw.input, pw.row), field('Role', role)),
      err,
      h('div', { class: 'admin-create__actions' }, submit),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const u = username.value.trim();
      const p = pw.input.value;
      const problem = checkUsername(u) ?? checkPassword(p);
      if (problem) return showError(err, problem);
      showError(err, null);
      void busy(submit, async () => {
        try {
          const user = await api.createUser(u, p, role.value as Role);
          this.users.push(user);
          this.render();
          this.showCreated(user.username, p);
          form.reset();
        } catch (ex) {
          showError(err, errorMessage(ex));
        }
      });
    });
    return form;
  }

  private showCreated(username: string, password: string): void {
    const both = `Weft: ${location.origin}\nUsername: ${username}\nPassword: ${password}`;
    this.created.replaceChildren(
      icon('check'),
      h('div', { class: 'created__text' }, h('strong', null, `Created ${username}`), h('span', null, 'Send them the sign-in details. The password isn’t shown again.')),
      h('button', { class: 'btn btn--outline', type: 'button', onclick: () => void copy(both, 'Sign-in details') }, icon('copy'), 'Copy details'),
    );
    this.created.hidden = false;
  }

  private render(): void {
    const me = this.host.me;
    this.count.textContent = this.users.length ? String(this.users.length) : '';
    const sorted = [...this.users].sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin') || a.username.localeCompare(b.username));
    this.list.replaceChildren(
      ...sorted.map((u) => {
        const badges = [
          u.id === me?.id ? h('span', { class: 'badge badge--you' }, 'You') : null,
          u.role === 'admin' ? h('span', { class: 'badge badge--admin' }, 'Admin') : null,
          u.disabled ? h('span', { class: 'badge badge--off' }, 'Disabled') : null,
        ];
        const more = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': `Actions for ${u.username}`, 'aria-haspopup': 'menu' }, icon('more'));
        more.addEventListener('click', () => this.openActions(u, more));
        return h(
          'li',
          { class: `user-row${u.disabled ? ' is-disabled' : ''}` },
          h('span', { class: 'account-btn', 'aria-hidden': 'true' }, initials(u.username)),
          h(
            'div',
            { class: 'user-row__main' },
            h('div', { class: 'user-row__name' }, h('strong', null, u.username), ...badges),
            h('div', { class: 'user-row__meta' }, `${u.note_count} note${u.note_count === 1 ? '' : 's'} · joined ${relativeTime(u.created_at)}`),
          ),
          more,
        );
      }),
    );
    if (!this.users.length) this.list.append(h('li', { class: 'users__empty' }, 'No people yet.'));
  }

  private openActions(u: AdminUser, anchor: HTMLElement): void {
    const self = u.id === this.host.me?.id;
    const items: MenuItem[] = [
      { label: 'Reset password…', icon: 'key', run: () => this.resetPassword(u) },
      u.role === 'admin'
        ? { label: 'Remove admin', icon: 'user', run: () => void this.patch(u, { role: 'user' }, `${u.username} is now a member`) }
        : { label: 'Make admin', icon: 'shield', run: () => void this.patch(u, { role: 'admin' }, `${u.username} is now an admin`) },
      u.disabled
        ? { label: 'Enable', icon: 'check', run: () => void this.patch(u, { disabled: false }, `${u.username} can sign in again`) }
        : { label: 'Disable', icon: 'ban', run: () => void this.patch(u, { disabled: true }, `${u.username} is disabled and signed out`) },
    ];
    if (!self) items.push({ label: 'Delete…', icon: 'trash', danger: true, run: () => void this.remove(u) });
    openMenu({ anchor, items, label: `Actions for ${u.username}`, align: 'end', header: h('div', { class: 'menu__header' }, h('strong', null, u.username), h('span', null, u.role === 'admin' ? 'Admin' : 'Member')) });
  }

  private async patch(u: AdminUser, patch: { role?: Role; disabled?: boolean }, done: string): Promise<void> {
    try {
      const next = await api.patchUser(u.id, patch);
      this.users = this.users.map((x) => (x.id === u.id ? next : x));
      showError(this.listError, null);
      this.render();
      toast(done, { icon: 'check' });
      if (u.id === this.host.me?.id && patch.role === 'user') this.host.goWall();
    } catch (e) {
      showError(this.listError, errorMessage(e));
      toast(errorMessage(e), { duration: 4000 });
    }
  }

  private resetPassword(u: AdminUser): void {
    const pw = newPasswordRow(generatePassword());
    const err = formError();
    const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Set password');
    const cancel = h('button', { class: 'btn btn--outline', type: 'button' }, 'Cancel');
    const form = h(
      'form',
      { class: 'modal__body', novalidate: true },
      h('p', { class: 'modal__text' }, `${u.username} will be signed out everywhere and must use this password next time.`),
      field('New password', pw.input, pw.row),
      err,
      h('div', { class: 'modal__actions' }, cancel, submit),
    );
    const m = openModal({ title: `Reset password for ${u.username}`, content: form });
    cancel.addEventListener('click', () => m.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const p = pw.input.value;
      const bad = checkPassword(p);
      if (bad) return showError(err, bad);
      void busy(submit, async () => {
        try {
          await api.patchUser(u.id, { password: p });
          m.close();
          toast(`Password reset for ${u.username}`, { icon: 'check', action: { label: 'Copy', run: () => void copy(p, 'Password') } });
        } catch (ex) {
          showError(err, errorMessage(ex));
        }
      });
    });
  }

  private async remove(u: AdminUser): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${u.username}?`,
      body: `This deletes their account and ${u.note_count === 1 ? 'their 1 note' : `all ${u.note_count} of their notes`}. It can’t be undone.`,
      confirm: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      this.users = this.users.filter((x) => x.id !== u.id);
      showError(this.listError, null);
      this.render();
      toast(`Deleted ${u.username}`, { icon: 'trash' });
    } catch (e) {
      showError(this.listError, errorMessage(e));
    }
  }
}
