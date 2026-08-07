import { api, esc, fmtDateTime, mountAppBar, toast } from './app.js';

const me = await mountAppBar({ title: '担当者の管理', back: '/' });

const rows = document.getElementById('rows');
const form = document.getElementById('addForm');
const addBtn = document.getElementById('addBtn');
const passwordArea = document.getElementById('passwordArea');

if (!me?.isAdmin) {
  document.querySelector('main').innerHTML =
    '<div class="note danger"><strong>権限がありません</strong>この画面は管理者のみ利用できます。</div>';
  throw new Error('管理者ではありません');
}

/**
 * パスワードは作成・再発行の直後にしか表示できない（保存しているのはハッシュのみ）。
 * 閉じるまで残しておき、伝え忘れを防ぐ。
 */
function showPassword(user, password, action) {
  passwordArea.innerHTML = `
    <div class="password-box">
      <strong>${esc(user.displayName)} さんの${esc(action)}</strong>
      <div class="value">${esc(password)}</div>
      <div>
        ユーザー名 <b>${esc(user.username)}</b> と、このパスワードをご本人にお伝えください。<br>
        <b>この表示は一度きりです。</b>閉じると二度と確認できません（忘れた場合は再発行してください）。
      </div>
      <div class="actions">
        <button class="btn" type="button" id="copyBtn">コピーする</button>
        <button class="btn" type="button" id="closePw">閉じる</button>
      </div>
    </div>`;
  window.scrollTo(0, 0);

  document.getElementById('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast('コピーしました', 'ok');
    } catch {
      toast('コピーできませんでした。手で控えてください。', 'err');
    }
  });
  document.getElementById('closePw').addEventListener('click', () => (passwordArea.innerHTML = ''));
}

async function load() {
  const { users } = await api('/api/users');

  rows.innerHTML = users
    .map((u) => {
      const self = u.id === me.id;
      return `<tr class="${u.active ? '' : 'inactive'}">
        <td><b>${esc(u.displayName)}</b>${self ? ' <span class="me">(自分)</span>' : ''}</td>
        <td><span class="token">${esc(u.username)}</span></td>
        <td>${u.isAdmin ? '<span class="badge issued">管理者</span>' : '担当者'}</td>
        <td>${u.active ? '<span class="badge completed">有効</span>' : '<span class="badge cancelled">無効</span>'}</td>
        <td>${u.issuedCount}</td>
        <td>
          <div class="row-actions">
            <button class="btn" data-act="password" data-id="${u.id}">パスワード再発行</button>
            ${self ? '' : `
              <button class="btn" data-act="admin" data-id="${u.id}" data-value="${u.isAdmin ? '0' : '1'}">
                ${u.isAdmin ? '管理者を外す' : '管理者にする'}
              </button>
              <button class="btn ${u.active ? 'danger' : ''}" data-act="active" data-id="${u.id}" data-value="${u.active ? '0' : '1'}">
                ${u.active ? '無効にする' : '有効に戻す'}
              </button>`}
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

rows.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;

  const { act, id, value } = btn.dataset;
  const name = btn.closest('tr').querySelector('b').textContent;
  btn.disabled = true;

  try {
    if (act === 'password') {
      if (!confirm(`${name} さんのパスワードを再発行しますか？\n今のパスワードは使えなくなります。`)) return;
      const { user, password } = await api(`/api/users/${id}/password`, { method: 'POST' });
      showPassword(user, password, 'パスワードを再発行しました');
    } else if (act === 'admin') {
      await api(`/api/users/${id}/admin`, { method: 'POST', body: { isAdmin: value === '1' } });
      toast('変更しました', 'ok');
    } else if (act === 'active') {
      const enabling = value === '1';
      if (!enabling && !confirm(`${name} さんを無効にしますか？\nログイン中の場合はその場でログアウトされます。`)) return;
      await api(`/api/users/${id}/active`, { method: 'POST', body: { active: enabling } });
      toast(enabling ? '有効に戻しました' : '無効にしました', 'ok');
    }
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  addBtn.disabled = true;

  try {
    const { user, password } = await api('/api/users', {
      method: 'POST',
      body: {
        username: form.username.value,
        displayName: form.displayName.value,
        isAdmin: document.getElementById('isAdmin').checked,
      },
    });
    showPassword(user, password, 'アカウントを作成しました');
    form.reset();
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    addBtn.disabled = false;
  }
});

/* 表示名からユーザー名を推測しない。ローマ字は人によって綴りが違うので、
   勝手に埋めると気づかないまま別人と紛らわしいIDになる。 */

await load();
