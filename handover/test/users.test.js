/**
 * 担当者アカウントの管理。
 * 事務9名＋倉庫の担当者が別々のアカウントを持つ運用を想定している。
 * 「誰が発行し、誰が引き渡したか」を追えることが目的なので、
 * アカウントの取り違えや、管理者が0人になる事故を防げるかを見る。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PORT = 19000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'admin-password-1234';

let server;
let tmp;

function session() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        origin: BASE,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    const isJson = res.headers.get('content-type')?.includes('application/json');
    return { status: res.status, body: isJson ? await res.json() : await res.text() };
  };
}

const login = (call, username, password) =>
  call('/api/login', { method: 'POST', body: { username, password } });

let admin;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'handover-users-'));
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HANDOVER_DB: join(tmp, 'u.db'), HANDOVER_ADMIN_PASSWORD: ADMIN_PW },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/login`);
      admin = session();
      await login(admin, 'admin', ADMIN_PW);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('サーバが起動しませんでした');
});

after(() => {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

test('初期の管理者アカウントには管理者権限がある', async () => {
  const me = await admin('/api/me');
  assert.equal(me.body.user.username, 'admin');
  assert.equal(me.body.user.isAdmin, true);
});

let staff;
let staffPassword;

test('事務9名ぶんのアカウントを作れる', async () => {
  const names = ['田中', '佐藤', '鈴木', '高橋', '渡辺', '伊藤', '山本', '中村', '小林'];
  const ids = ['tanaka', 'sato', 'suzuki', 'takahashi', 'watanabe', 'ito', 'yamamoto', 'nakamura', 'kobayashi'];

  const created = [];
  for (let i = 0; i < names.length; i++) {
    const res = await admin('/api/users', {
      method: 'POST',
      body: { username: ids[i], displayName: names[i] },
    });
    assert.equal(res.status, 201, `${names[i]} の作成に失敗`);
    created.push(res.body);
  }

  // パスワードは作成時の応答でしか返らない
  assert.ok(created.every((c) => typeof c.password === 'string' && c.password.length >= 12));
  assert.equal(new Set(created.map((c) => c.password)).size, 9, 'パスワードが使い回されている');

  staff = created[0].user;
  staffPassword = created[0].password;

  const list = await admin('/api/users');
  assert.equal(list.body.users.length, 10, '管理者1名 + 事務9名');
});

test('作ったアカウントでログインでき、履歴に表示名が残る', async () => {
  const call = session();
  const res = await login(call, 'tanaka', staffPassword);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.displayName, '田中');

  const created = await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: '発行者テスト', item_count: 1 },
  });
  assert.equal(created.body.handover.issued_by, '田中', '誰が発行したか残っていない');
});

test('一覧にはパスワードのハッシュを出さない', async () => {
  const list = await admin('/api/users');
  const raw = JSON.stringify(list.body);
  assert.ok(!raw.includes('scrypt'), 'パスワードハッシュが漏れている');
  assert.ok(!raw.includes('password_hash'), 'パスワードハッシュが漏れている');
});

test('ユーザー名の重複は弾かれる', async () => {
  const res = await admin('/api/users', {
    method: 'POST',
    body: { username: 'tanaka', displayName: '田中（別人）' },
  });
  assert.equal(res.status, 409);
});

test('ユーザー名・表示名の形式を検査する', async () => {
  for (const bad of ['', 'a', '田中', 'has space', 'UPPER!'.repeat(6)]) {
    const res = await admin('/api/users', { method: 'POST', body: { username: bad, displayName: 'X' } });
    assert.equal(res.status, 400, `「${bad}」が通ってしまった`);
  }
  const noName = await admin('/api/users', { method: 'POST', body: { username: 'noname', displayName: '  ' } });
  assert.equal(noName.status, 400);
});

test('パスワードを再発行すると、古いパスワードでは入れなくなる', async () => {
  const reset = await admin(`/api/users/${staff.id}/password`, { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.body.password, staffPassword);

  const oldTry = await login(session(), 'tanaka', staffPassword);
  assert.equal(oldTry.status, 401, '古いパスワードで入れてしまう');

  const newTry = await login(session(), 'tanaka', reset.body.password);
  assert.equal(newTry.status, 200);
  staffPassword = reset.body.password;
});

test('無効にするとログインできなくなり、ログイン中のセッションも切れる', async () => {
  const call = session();
  await login(call, 'tanaka', staffPassword);
  assert.equal((await call('/api/handovers?limit=1')).status, 200);

  await admin(`/api/users/${staff.id}/active`, { method: 'POST', body: { active: false } });

  // ログイン中だった端末もその場で使えなくなる
  assert.equal((await call('/api/handovers?limit=1')).status, 401, 'セッションが残っている');

  const relogin = await login(session(), 'tanaka', staffPassword);
  assert.equal(relogin.status, 403);
  assert.match(relogin.body.error, /無効/);
});

test('有効に戻すとまた使える', async () => {
  await admin(`/api/users/${staff.id}/active`, { method: 'POST', body: { active: true } });
  const res = await login(session(), 'tanaka', staffPassword);
  assert.equal(res.status, 200);
});

test('担当者は他人のアカウントを操作できない', async () => {
  const call = session();
  await login(call, 'tanaka', staffPassword);

  assert.equal((await call('/api/users')).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', body: { username: 'x', displayName: 'X' } })).status, 403);
  assert.equal((await call(`/api/users/${staff.id}/password`, { method: 'POST' })).status, 403);
  assert.equal((await call(`/api/users/1/active`, { method: 'POST', body: { active: false } })).status, 403);
});

test('管理者が0人になる操作は拒否される', async () => {
  const me = (await admin('/api/me')).body.user;

  // 自分自身は無効化も権限剥奪もできない
  const selfOff = await admin(`/api/users/${me.id}/active`, { method: 'POST', body: { active: false } });
  assert.equal(selfOff.status, 409);
  const selfDemote = await admin(`/api/users/${me.id}/admin`, { method: 'POST', body: { isAdmin: false } });
  assert.equal(selfDemote.status, 409);

  // 別の管理者を立ててからなら外せる
  const second = await admin('/api/users', {
    method: 'POST',
    body: { username: 'kanri2', displayName: '管理者2', isAdmin: true },
  });
  assert.equal(second.body.user.isAdmin, true);

  const demote = await admin(`/api/users/${second.body.user.id}/admin`, {
    method: 'POST',
    body: { isAdmin: false },
  });
  assert.equal(demote.status, 200);
  assert.equal(demote.body.user.isAdmin, false);
});

test('管理者に昇格した担当者は管理操作ができる', async () => {
  await admin(`/api/users/${staff.id}/admin`, { method: 'POST', body: { isAdmin: true } });

  const call = session();
  await login(call, 'tanaka', staffPassword);
  assert.equal((await call('/api/me')).body.user.isAdmin, true);
  assert.equal((await call('/api/users')).status, 200);
});
