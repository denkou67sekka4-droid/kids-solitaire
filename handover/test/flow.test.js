import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPng } from '../src/qr.js';
import { freePort } from './helpers.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
let PORT;
let HTTPS_PORT;
let BASE;
const PASSWORD = 'test-password-1234';

let server;
let tmp;
let cookie = '';

/** Node の fetch は Cookie を自動で保持しないので、ここで持ち回す */
async function call(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      origin: BASE,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) cookie = c.split(';')[0];

  if (raw) return res;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : await res.text() };
}

before(async () => {
  PORT = await freePort();
  HTTPS_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  tmp = mkdtempSync(join(tmpdir(), 'handover-test-'));

  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HTTPS_PORT: String(HTTPS_PORT),
      HANDOVER_DB: join(tmp, 'test.db'),
      HANDOVER_ADMIN_PASSWORD: PASSWORD,
      HANDOVER_ORG_NAME: 'テスト株式会社',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // 起動待ち
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/login`);
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

test('未ログインでは引渡票にアクセスできない', async () => {
  const res = await call('/api/handovers');
  assert.equal(res.status, 401);
});

test('未ログインで画面を開くとログイン画面へ飛ばされる', async () => {
  const res = await call('/issue', { raw: true });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?next=/);
});

test('間違ったパスワードでは入れない', async () => {
  const res = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  assert.equal(res.status, 401);
});

test('ログインできる', async () => {
  const res = await call('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'admin');
  assert.ok(cookie.startsWith('handover_session='));
});

let handover;
let packages;

test('引渡票を発行できる', async () => {
  const res = await call('/api/handovers', {
    method: 'POST',
    body: {
      customer_name: '山田 太郎',
      customer_kana: 'ヤマダ タロウ',
      company: '山田商店',
      phone: '090-1234-5678',
      email: 'yamada@example.com',
      order_no: 'JT-2026-0001',
      item_desc: '事務机 3台',
      item_count: 3,
      storage_location: '第2倉庫 A-12',
      pickup_until: '2026-12-31',
      note: '車で来店予定',
    },
  });

  assert.equal(res.status, 201);
  handover = res.body.handover;
  assert.equal(handover.status, 'issued');
  assert.equal(handover.customer_name, '山田 太郎');
  assert.equal(handover.item_count, 3);
  assert.match(handover.token, /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
});

test('個数のぶんだけ荷物ラベルが自動発行される', async () => {
  const res = await call(`/api/handovers/${handover.id}`);
  packages = res.body.packages;

  assert.equal(packages.length, 3, '3個の荷物に3枚のラベルが要る');
  assert.deepEqual(packages.map((p) => p.seq), [1, 2, 3]);
  for (const p of packages) {
    assert.match(p.token, /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
  }
});

test('荷物ラベルの番号は引渡票の番号と重複しない', async () => {
  const tokens = new Set([handover.token, ...packages.map((p) => p.token)]);
  assert.equal(tokens.size, 4, '番号が重複している');
});

test('お客様名が空だと発行できない', async () => {
  const res = await call('/api/handovers', { method: 'POST', body: { customer_name: '  ', item_count: 1 } });
  assert.equal(res.status, 400);
});

test('個数が0以下だと発行できない', async () => {
  const res = await call('/api/handovers', { method: 'POST', body: { customer_name: 'テスト', item_count: 0 } });
  assert.equal(res.status, 400);
});

test('引取期限が引取開始日より前だと発行できない', async () => {
  const res = await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: 'テスト', item_count: 1, pickup_from: '2026-05-01', pickup_until: '2026-04-01' },
  });
  assert.equal(res.status, 400);
});

test('QRのSVGとPNGを取得できる', async () => {
  const svg = await call(`/qr/${handover.token}.svg`, { raw: true });
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(await svg.text(), /^<svg /);

  const png = await call(`/qr/${handover.token}.png`, { raw: true });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await png.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});

test('引渡番号で照会できる（ハイフン無し・小文字でも）', async () => {
  const a = await call(`/api/lookup?token=${encodeURIComponent(handover.token)}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.kind, 'handover');
  assert.equal(a.body.handover.id, handover.id);
  assert.equal(a.body.packages.length, 3);

  const messy = handover.token.replace(/-/g, '').toLowerCase();
  const b = await call(`/api/lookup?token=${encodeURIComponent(messy)}`);
  assert.equal(b.status, 200);
  assert.equal(b.body.handover.id, handover.id);
});

test('荷物ラベルを照会すると「荷物」として、親の引渡票つきで返る', async () => {
  const res = await call(`/api/lookup?token=${encodeURIComponent(packages[1].token)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'package');
  assert.equal(res.body.package.seq, 2);
  assert.equal(res.body.handover.id, handover.id);
  assert.equal(res.body.handover.customer_name, '山田 太郎');
});

test('存在しない引渡番号は404', async () => {
  // 形式は正しいがDBに無いもの（チェックディジットを総当たりで合わせる）
  const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  let notFound = null;
  for (const c of alphabet) {
    const candidate = `2345-6789-ABC${c}`;
    const res = await call(`/api/lookup?token=${candidate}`);
    if (res.status === 404) { notFound = res; break; }
  }
  assert.ok(notFound, '形式の正しい未登録トークンを作れなかった');
});

test('形式が不正な引渡番号は400', async () => {
  const res = await call('/api/lookup?token=ABC');
  assert.equal(res.status, 400);
});

test('照会すると履歴に残る', async () => {
  const res = await call(`/api/handovers/${handover.id}`);
  const types = res.body.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ['issued', 'scanned']);
});

test('サインなしでは引渡しを確定できない', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: { receiverName: '山田 太郎' },
  });
  assert.equal(res.status, 400);
});

test('受領者名なしでは引渡しを確定できない', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: { receiverName: '  ', signature: signatureDataUrl() },
  });
  assert.equal(res.status, 400);
});

test('PNG以外のサインは受け付けない', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: { receiverName: '山田 太郎', signature: 'data:image/jpeg;base64,AAAA' },
  });
  assert.equal(res.status, 400);
});

test('荷物ラベルを照合していないと確定できない', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: { receiverName: '山田 太郎', signature: signatureDataUrl(), packageTokens: [] },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /照合が未完了/);
});

test('荷物ラベルが一部だけでは確定できない', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: {
      receiverName: '山田 太郎',
      signature: signatureDataUrl(),
      packageTokens: [packages[0].token, packages[1].token],
    },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /未確認: 3/);
});

test('別のお客様の荷物ラベルを混ぜると拒否される', async () => {
  const other = await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: '鈴木 次郎', item_count: 1 },
  });
  const otherPkgs = (await call(`/api/handovers/${other.body.handover.id}`)).body.packages;

  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: {
      receiverName: '山田 太郎',
      signature: signatureDataUrl(),
      packageTokens: [packages[0].token, packages[1].token, otherPkgs[0].token],
    },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /別のお客様の荷物/);
});

test('画面を通さず直接呼んでも、照合を飛ばして確定はできない', async () => {
  // 画面側のチェックはサーバ側でもう一度やっているので、通信を細工しても抜けられない
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: { receiverName: '山田 太郎', signature: signatureDataUrl() }, // packageTokens 自体を送らない
  });
  assert.equal(res.status, 409);

  const still = await call(`/api/handovers/${handover.id}`);
  assert.equal(still.body.handover.status, 'issued', '状態が変わってしまっている');
});

test('サイン付きで引渡しを確定できる', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: {
      receiverName: '山田 花子',
      receiverRelation: 'agent',
      note: '1箱に軽微な擦れあり・お客様了承済み',
      signature: signatureDataUrl(),
      packageTokens: packages.map((p) => p.token),
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.handover.status, 'completed');
  assert.ok(res.body.handover.completed_at);

  const done = res.body.events.find((e) => e.type === 'completed');
  assert.equal(done.receiver_name, '山田 花子');
  assert.equal(done.receiver_relation, 'agent');
  assert.equal(done.has_signature, 1);
  assert.match(done.record_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(done.packages_scanned), [1, 2, 3], '照合した箱が記録されていない');
});

test('同じQRで二重に引渡しはできない', async () => {
  const res = await call(`/api/handovers/${handover.id}/complete`, {
    method: 'POST',
    body: {
      receiverName: '別人',
      signature: signatureDataUrl(),
      packageTokens: packages.map((p) => p.token),
    },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /既に引渡し済み/);
});

test('理由をつければ、そろっていない状態でも引き渡せる（履歴に残る）', async () => {
  const created = await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: '一部引渡テスト', item_count: 3 },
  });
  const id = created.body.handover.id;
  const pkgs = (await call(`/api/handovers/${id}`)).body.packages;

  const res = await call(`/api/handovers/${id}/complete`, {
    method: 'POST',
    body: {
      receiverName: '一部引渡テスト',
      signature: signatureDataUrl(),
      packageTokens: [pkgs[0].token],
      overrideReason: '2箱目・3箱目は別便で発送済み',
    },
  });

  assert.equal(res.status, 200);
  const done = res.body.events.find((e) => e.type === 'completed');
  assert.deepEqual(JSON.parse(done.packages_scanned), [1]);
  assert.match(done.note, /一部のみ引渡し/);
  assert.match(done.note, /未確認の荷物: 2, 3/);
  assert.match(done.note, /別便で発送済み/);
});

test('個数を変えると荷物ラベルが発行しなおされる', async () => {
  const created = await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: '個数変更テスト', item_count: 2 },
  });
  const id = created.body.handover.id;
  const before = (await call(`/api/handovers/${id}`)).body.packages;
  assert.equal(before.length, 2);

  await call(`/api/handovers/${id}`, {
    method: 'PUT',
    body: { customer_name: '個数変更テスト', item_count: 4 },
  });

  const after = (await call(`/api/handovers/${id}`)).body;
  assert.equal(after.packages.length, 4);
  // 古いラベルは無効になる（貼り替えが要ることが履歴で分かる）
  assert.ok(after.packages.every((p) => !before.some((b) => b.token === p.token)));
  assert.match(after.events.at(-1).note, /荷物ラベルを再発行/);

  const stale = await call(`/api/lookup?token=${encodeURIComponent(before[0].token)}`);
  assert.equal(stale.status, 404, '古いラベルがまだ通用してしまう');
});

test('引渡済みの票は編集できない', async () => {
  const res = await call(`/api/handovers/${handover.id}`, {
    method: 'PUT',
    body: { customer_name: '書き換え', item_count: 1 },
  });
  assert.equal(res.status, 409);
});

test('引渡済みの票は取消できない', async () => {
  const res = await call(`/api/handovers/${handover.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
});

test('サイン画像を取得できる', async () => {
  const res = await call(`/api/handovers/${handover.id}/signature.png`, { raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});

test('引渡済みの票を照会すると状態が completed で返る', async () => {
  const res = await call(`/api/lookup?token=${handover.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.handover.status, 'completed');
});

test('発行済みの票は取消できる', async () => {
  const created = await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: '取消テスト', item_count: 1 },
  });
  const id = created.body.handover.id;

  const res = await call(`/api/handovers/${id}/cancel`, { method: 'POST', body: { note: '発注取消のため' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.handover.status, 'cancelled');

  // 取消済みの票では引渡しできない
  const pkgs = (await call(`/api/handovers/${id}`)).body.packages;
  const done = await call(`/api/handovers/${id}/complete`, {
    method: 'POST',
    body: { receiverName: 'テスト', signature: signatureDataUrl(), packageTokens: pkgs.map((p) => p.token) },
  });
  assert.equal(done.status, 409);
  assert.match(done.body.error, /取消/);
});

test('検索できる', async () => {
  const res = await call('/api/handovers?q=' + encodeURIComponent('山田商店'));
  assert.equal(res.status, 200);
  assert.ok(res.body.items.some((h) => h.id === handover.id));

  const none = await call('/api/handovers?q=' + encodeURIComponent('存在しない会社XYZ'));
  assert.equal(none.body.items.length, 0);
});

test('状態で絞り込める', async () => {
  const res = await call('/api/handovers?status=completed');
  assert.ok(res.body.items.length > 0);
  assert.ok(res.body.items.every((h) => h.status === 'completed'));
});

test('CSVを書き出せる（Excel向けBOM付き）', async () => {
  const res = await call('/api/export.csv', { raw: true });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const text = buf.subarray(3).toString('utf8');
  assert.match(text, /引渡番号/);
  assert.match(text, /山田 太郎/);
});

test('CSVの数式インジェクションを無害化する', async () => {
  await call('/api/handovers', {
    method: 'POST',
    body: { customer_name: '=1+1', item_count: 1, note: '@SUM(A1:A9)' },
  });
  const res = await call('/api/export.csv', { raw: true });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');

  assert.ok(text.includes(`"'=1+1"`), '先頭の = が無害化されていない');
  assert.ok(text.includes(`"'@SUM(A1:A9)"`), '先頭の @ が無害化されていない');
});

test('別サイトからの書き込みは拒否される（CSRF対策）', async () => {
  const res = await fetch(`${BASE}/api/handovers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example.com' },
    body: JSON.stringify({ customer_name: '攻撃', item_count: 1 }),
  });
  assert.equal(res.status, 403);
});

test('パストラバーサルでファイルを読み出せない', async () => {
  for (const p of ['/../package.json', '/css/../../package.json', '/%2e%2e/package.json']) {
    const res = await call(p, { raw: true });
    assert.ok(res.status >= 400, `${p} が通ってしまった (${res.status})`);
  }
});

test('スマホから開くためのURLとQRを出せる', async () => {
  const res = await call('/api/connect');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.urls));

  // 証明書があれば https、無ければ http で案内する（無い場合は画面側で
  // カメラが使えない旨を出す）。どちらでもURLの形は揃っていること。
  const scheme = res.body.secure ? 'https' : 'http';
  const port = res.body.secure ? res.body.httpsPort : res.body.httpPort;
  for (const u of res.body.urls) {
    assert.match(u, new RegExp(`^${scheme}://\\d+\\.\\d+\\.\\d+\\.\\d+:${port}$`), `URLの形が違う: ${u}`);
  }

  if (res.body.urls.length) {
    const qr = await call('/qr/connect.svg?i=0', { raw: true });
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    // URLはバイトモードで入るので、引渡番号だけのQR（29マス）より大きくなる
    const svg = await qr.text();
    assert.ok(Number(svg.match(/viewBox="0 0 (\d+)/)[1]) > 29);
  }

  assert.equal((await call('/qr/connect.svg?i=999', { raw: true })).status, 404);
});

test('CA証明書は用意されていなければ404を返す', async () => {
  // このテスト環境には証明書を作っていないので、その旨が分かる応答になること
  const info = await call('/api/connect');
  const res = await call('/ca.crt', { raw: true });

  if (info.body.caAvailable) {
    assert.equal(res.status, 200);
    assert.match(await res.text(), /^-----BEGIN CERTIFICATE-----/);
  } else {
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /make-cert/);
  }
});

test('CA証明書はログインしないと取れない', async () => {
  assert.equal((await fetch(`${BASE}/ca.crt`)).status, 401);
});

test('秘密鍵は配信されない', async () => {
  // ca.key / server.key が外から取れてしまうと、なりすましが可能になる
  for (const p of ['/ca.key', '/certs/ca.key', '/certs/server.key', '/server.key']) {
    const res = await call(p, { raw: true });
    assert.ok(res.status >= 400, `${p} が取得できてしまう (${res.status})`);
  }
});

test('スマホ用のURLはログインしないと見られない', async () => {
  const anon = await fetch(`${BASE}/api/connect`);
  assert.equal(anon.status, 401, '社内のIPアドレスが誰にでも見えてしまう');
});

test('生存確認はログインなしで見られる', async () => {
  const anon = await fetch(`${BASE}/health`);
  assert.equal(anon.status, 200);

  const body = await anon.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isInteger(body.uptimeSec));
});

test('生存確認は業務データを一切返さない', async () => {
  // ログイン不要で開ける以上、顧客情報が混じっていてはいけない
  const json = await (await fetch(`${BASE}/health`)).text();
  const html = await (await fetch(`${BASE}/health`, { headers: { accept: 'text/html' } })).text();

  for (const text of [json, html]) {
    for (const secret of ['山田', '090-1234', 'JT-2026', handover.token, 'customer']) {
      assert.ok(!text.includes(secret), `生存確認に「${secret}」が漏れている`);
    }
  }
  assert.match(html, /動いています/);
});

test('ログアウトするとアクセスできなくなる', async () => {
  await call('/api/logout', { method: 'POST' });
  const res = await call('/api/handovers');
  assert.equal(res.status, 401);
});

/** テスト用の有効なPNG。QR生成器を流用して正当なPNGを作る。 */
function signatureDataUrl() {
  return `data:image/png;base64,${toPng('TEST-SIGN-DATA', { targetPx: 300 }).toString('base64')}`;
}
