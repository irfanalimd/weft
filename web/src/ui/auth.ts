// Sign-in and first-run setup pages: one small centered card each.

import { api, checkPassword, checkUsername, errorMessage, type User } from '../api';
import { passwordInput } from './account';
import { h } from './dom';
import { logoSvg } from './icons';
import { busy, field, formError, showError } from './modal';

const finePointer = window.matchMedia('(pointer: fine)');

function shell(title: string, sub: string, form: HTMLElement, foot?: Node | null): HTMLElement {
  const logo = h('div', { class: 'auth__logo', 'aria-hidden': 'true' });
  logo.innerHTML = logoSvg;
  return h(
    'div',
    { class: 'auth' },
    h('main', { class: 'auth__card', id: 'main' }, logo, h('h1', { class: 'auth__title' }, title), h('p', { class: 'auth__sub' }, sub), form),
    foot ? h('footer', { class: 'auth__foot' }, foot) : null,
  );
}

function textInput(attrs: Record<string, string | boolean>): HTMLInputElement {
  return h('input', { class: 'input', type: 'text', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, ...attrs });
}

export function signInPage(opts: {
  anonymousDocs: boolean;
  notice?: string | null;
  onSignedIn: (u: User) => void;
  onTempDoc: () => void;
}): HTMLElement {
  const username = textInput({ name: 'username', autocomplete: 'username', inputmode: 'text', enterkeyhint: 'next' });
  const pw = passwordInput('current-password', { name: 'password', enterkeyhint: 'go' });
  const err = formError();
  const submit = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Sign in');
  const notice = opts.notice ? h('p', { class: 'auth__notice', role: 'status' }, opts.notice) : null;
  const form = h(
    'form',
    { class: 'auth__form', method: 'post', action: '/api/auth/login', novalidate: true },
    notice,
    field('Username', username),
    field('Password', pw.input, pw.toggle),
    err,
    submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = username.value.trim();
    if (!u) return showError(err, 'Enter your username.'), username.focus();
    if (!pw.input.value) return showError(err, 'Enter your password.'), pw.input.focus();
    showError(err, null);
    void busy(submit, async () => {
      try {
        opts.onSignedIn(await api.login(u, pw.input.value));
      } catch (ex) {
        showError(err, errorMessage(ex));
        pw.input.select();
      }
    });
  });
  let foot: Node | null = null;
  if (opts.anonymousDocs) {
    const link = h('a', { class: 'auth__link', href: '/d' }, 'Start a temporary doc');
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      opts.onTempDoc();
    });
    foot = h('span', null, 'No account? ', link, h('span', { class: 'auth__muted' }, ' · anyone with the link can edit'));
  }
  const page = shell('Sign in to Weft', 'Your notes, saved and synced on every device.', form, foot);
  if (finePointer.matches) queueMicrotask(() => username.focus({ preventScroll: true }));
  return page;
}

export function setupPage(opts: { onDone: (u: User) => void }): HTMLElement {
  const token = textInput({ name: 'token', autocomplete: 'off', class: 'input input--mono', enterkeyhint: 'next' });
  const username = textInput({ name: 'username', autocomplete: 'username', enterkeyhint: 'next', minlength: '3', maxlength: '32' });
  const pw = passwordInput('new-password', { name: 'password', minlength: '10', maxlength: '256', enterkeyhint: 'go' });
  const err = formError();
  const submit = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Create admin account');
  const form = h(
    'form',
    { class: 'auth__form', method: 'post', action: '/api/auth/setup', novalidate: true },
    field('Bootstrap token', token, null, 'The WEFT_BOOTSTRAP_TOKEN value from the server’s environment file.'),
    field('Admin username', username, null, '3–32 letters, numbers, dot, dash or underscore.'),
    field('Password', pw.input, pw.toggle, 'At least 10 characters. A passphrase is great.'),
    err,
    submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = token.value.trim();
    const u = username.value.trim();
    const problem = !t ? 'Paste the bootstrap token.' : checkUsername(u) ?? checkPassword(pw.input.value);
    if (problem) return showError(err, problem);
    showError(err, null);
    void busy(submit, async () => {
      try {
        opts.onDone(await api.setup(t, u, pw.input.value));
      } catch (ex) {
        showError(err, errorMessage(ex));
      }
    });
  });
  const page = shell('Welcome to Weft', 'Create the admin account for this server. You can add other people afterwards.', form);
  if (finePointer.matches) queueMicrotask(() => token.focus({ preventScroll: true }));
  return page;
}
