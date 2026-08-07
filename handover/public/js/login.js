import { api, toast } from './app.js';

const form = document.getElementById('loginForm');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;

  try {
    await api('/api/login', {
      method: 'POST',
      body: {
        username: form.username.value,
        password: form.password.value,
      },
    });

    // next は「同一サイト内のパス」だけを許す（外部サイトへ飛ばされないように）
    const next = new URLSearchParams(location.search).get('next') ?? '/';
    location.href = /^\/(?!\/)/.test(next) ? next : '/';
  } catch (err) {
    toast(err.message, 'err');
    form.password.value = '';
    form.password.focus();
    btn.disabled = false;
  }
});
