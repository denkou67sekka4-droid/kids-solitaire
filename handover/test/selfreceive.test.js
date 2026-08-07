/**
 * 時間外のお客様セルフ受取。
 *
 * ワゴンに置いた紙のQRを、お客様ご自身のスマホで読んで受け取りを記録する経路。
 * ログインできない相手に開く画面なので、
 *   ・出してよい情報だけを出しているか
 *   ・二重で受け取り記録が立たないか
 *   ・係員の照合を経ていないことが記録に残るか
 * を重点的に見る。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPng } from '../src/qr.js';
import { generateToken } from '../src/token.js';

/** 形式は正しいが、どこにも登録されていない番号 */
const unregisteredToken = () => generateToken();

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PORT = 19500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'self-test-1234';
const PUBLIC_URL = 'https://handover.example.co.jp';

let server;
let tmp;
let staff;

const signature = () => `data:image/png;base64,${toPng('TEST-SIGN-DATA', { targetPx: 300 }).toString('base64')}`;

function session() {
  let cookie = '';
  return async (path, { method = 'GET', body, raw = false } = {}) => {
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
    if (raw) return res;
    const isJson = res.headers.get('content-type')?.includes('application/json');
    return { status: res.status, body: isJson ? await res.json() : await res.text() };
  };
}

/** お客様の端末（ログインしていない）からの呼び出し */
async function guest(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      origin: BASE,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : await res.text() };
}

async function newHandover(extra = {}) {
  const res = await staff('/api/handovers', {
    method: 'POST',
    body: {
      customer_name: '夜間 太郎',
      company: '夜間商事',
      phone: '090-9999-8888',
      email: 'yakan@example.com',
      order_no: 'NG-2026-0001',
      item_desc: '棚 2台',
      item_count: 2,
      note: '時間外引取り予定',
      ...extra,
    },
  });
  return res.body.handover;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'handover-self-'));
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HANDOVER_DB: join(tmp, 's.db'),
      HANDOVER_ADMIN_PASSWORD: PASSWORD,
      HANDOVER_PUBLIC_URL: PUBLIC_URL,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/login`);
      staff = session();
      await staff('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
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

test('受取画面はログインなしで開ける', async () => {
  const h = await newHandover();
  const res = await fetch(`${BASE}/r/${h.token}`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200, 'ログイン画面に飛ばされている');
  assert.match(await res.text(), /お荷物の受け取り/);
});

test('お客様に出す情報は必要最小限（電話番号・メールは出さない）', async () => {
  const h = await newHandover();
  const res = await guest(`/api/r/${h.token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.handover.customerName, '夜間 太郎');
  assert.equal(res.body.handover.itemCount, 2);

  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('090-9999-8888'), '電話番号が漏れている');
  assert.ok(!raw.includes('yakan@example.com'), 'メールアドレスが漏れている');
  assert.ok(!raw.includes('issued_by'), '社内の担当者名が漏れている');
});

test('存在しない番号・不正な番号は受け付けない', async () => {
  // 形式が違うもの（チェックディジットで弾かれる）
  assert.equal((await guest('/api/r/ABC')).status, 400);
  assert.equal((await guest('/api/r/2345-6789-ABCD')).status, 400);

  // 形式は正しいが登録されていないもの
  assert.equal((await guest(`/api/r/${unregisteredToken()}`)).status, 404);
});

test('サインなし・お名前なしでは受け取れない', async () => {
  const h = await newHandover();

  const noSign = await guest(`/api/r/${h.token}/receive`, {
    method: 'POST',
    body: { receiverName: '夜間 太郎' },
  });
  assert.equal(noSign.status, 400);

  const noName = await guest(`/api/r/${h.token}/receive`, {
    method: 'POST',
    body: { receiverName: '  ', signature: signature() },
  });
  assert.equal(noName.status, 400);

  // どちらも状態を変えていないこと
  assert.equal((await guest(`/api/r/${h.token}`)).body.handover.status, 'issued');
});

test('お客様がサインすると受け取り済みになる', async () => {
  const h = await newHandover();

  const res = await guest(`/api/r/${h.token}/receive`, {
    method: 'POST',
    body: { receiverName: '夜間 太郎', signature: signature() },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.handover.status, 'completed');

  // 事務側から見ると、日中の引渡しと区別できる形で残っている
  const detail = await staff(`/api/handovers/${h.id}`);
  assert.equal(detail.body.handover.status, 'completed');

  const done = detail.body.events.find((e) => e.type === 'self_received');
  assert.ok(done, '時間外セルフ受取として記録されていない');
  assert.equal(done.receiver_name, '夜間 太郎');
  assert.equal(done.has_signature, 1);
  assert.match(done.note, /係員による荷物の照合は行われていません/);
  assert.deepEqual(JSON.parse(done.packages_scanned), [], '照合していないのに照合済になっている');
});

test('二度目は受け取れない', async () => {
  const h = await newHandover();
  const body = { receiverName: '夜間 太郎', signature: signature() };

  assert.equal((await guest(`/api/r/${h.token}/receive`, { method: 'POST', body })).status, 200);

  const second = await guest(`/api/r/${h.token}/receive`, { method: 'POST', body });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /受け取り済み/);

  // 記録も1件だけ
  const events = (await staff(`/api/handovers/${h.id}`)).body.events.filter(
    (e) => e.type === 'self_received'
  );
  assert.equal(events.length, 1);
});

test('同時に2回押されても1回しか通らない', async () => {
  const h = await newHandover();
  const body = { receiverName: '夜間 太郎', signature: signature() };

  const [a, b] = await Promise.all([
    guest(`/api/r/${h.token}/receive`, { method: 'POST', body }),
    guest(`/api/r/${h.token}/receive`, { method: 'POST', body }),
  ]);

  assert.equal([a, b].filter((r) => r.status === 200).length, 1);
  assert.equal([a, b].filter((r) => r.status === 409).length, 1);
});

test('取消済みの荷物は受け取れない', async () => {
  const h = await newHandover();
  await staff(`/api/handovers/${h.id}/cancel`, { method: 'POST', body: { note: '発注取消' } });

  const res = await guest(`/api/r/${h.token}/receive`, {
    method: 'POST',
    body: { receiverName: '夜間 太郎', signature: signature() },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /無効/);
});

test('日中に係員が引き渡した荷物は、あとからセルフ受取できない', async () => {
  const h = await newHandover();
  const pkgs = (await staff(`/api/handovers/${h.id}`)).body.packages;

  await staff(`/api/handovers/${h.id}/complete`, {
    method: 'POST',
    body: {
      receiverName: '夜間 太郎',
      signature: signature(),
      packageTokens: pkgs.map((p) => p.token),
    },
  });

  const res = await guest(`/api/r/${h.token}/receive`, {
    method: 'POST',
    body: { receiverName: '別人', signature: signature() },
  });
  assert.equal(res.status, 409);
});

test('セルフ受取用のQRにはお客様がアクセスできるURLが入る', async () => {
  const h = await newHandover();

  // 社内の画面から出すものなのでログインが要る
  assert.equal((await guest(`/qr/r/${h.token}.svg`)).status, 401);

  const res = await staff(`/qr/r/${h.token}.svg`, { raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');

  const svg = await res.text();
  assert.match(svg, /^<svg /);
  // 引渡番号だけのQR（バージョン1・29マス）より大きくなる＝URLが入っている
  const viewBox = svg.match(/viewBox="0 0 (\d+)/)[1];
  assert.ok(Number(viewBox) > 29, `URLが入っていない可能性がある（${viewBox}マス）`);
});

test('設定より少ない情報しか無いときはQRを作らない', async () => {
  // HANDOVER_PUBLIC_URL 未設定のサーバでは409を返して気づけるようにする
  const bare = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT + 1),
      HANDOVER_DB: join(tmp, 'bare.db'),
      HANDOVER_ADMIN_PASSWORD: PASSWORD,
      HANDOVER_PUBLIC_URL: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    const bareBase = `http://127.0.0.1:${PORT + 1}`;
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${bareBase}/login`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    let cookie = '';
    const login = await fetch(`${bareBase}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: bareBase },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    for (const c of login.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];

    const created = await fetch(`${bareBase}/api/handovers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: bareBase },
      body: JSON.stringify({ customer_name: 'URL未設定テスト', item_count: 1 }),
    });
    const token = (await created.json()).handover.token;

    const qr = await fetch(`${bareBase}/qr/r/${token}.svg`, { headers: { cookie } });
    assert.equal(qr.status, 409);
    assert.match((await qr.json()).error, /HANDOVER_PUBLIC_URL/);

    const cfg = await fetch(`${bareBase}/api/config`, { headers: { cookie } });
    assert.equal((await cfg.json()).publicUrl, '');
  } finally {
    bare.kill();
  }
});

test('短時間に呼びすぎると止められる（総当たり対策）', async () => {
  let blocked = false;
  for (let i = 0; i < 40; i++) {
    const res = await guest(`/api/r/${unregisteredToken()}/receive`, {
      method: 'POST',
      body: { receiverName: 'x', signature: signature() },
    });
    if (res.status === 429) {
      blocked = true;
      break;
    }
  }
  assert.ok(blocked, '何度呼んでも制限がかからない');
});
