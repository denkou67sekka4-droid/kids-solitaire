/**
 * 事務9人が同時に使う想定の検証。
 *
 * 見たいのは2点:
 *   1. 9台から一斉に発行しても、番号が重複せず取りこぼしも出ないか
 *   2. 倉庫の端末が同時に同じ荷物を確定しようとしたとき、片方だけが通るか
 *      （二重渡しは現場でいちばん困る事故なので、競合下でも1回だけにする）
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPng } from '../src/qr.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PORT = 18500 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'concurrent-test-1234';
const DESKS = 9; // 事務のPC台数

let server;
let tmp;

/** 端末1台ぶんのセッション（Cookieを個別に持つ） */
async function openSession() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
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

  await call('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  return call;
}

const signature = () => `data:image/png;base64,${toPng('TEST-SIGN-DATA', { targetPx: 300 }).toString('base64')}`;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'handover-conc-'));
  server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HANDOVER_DB: join(tmp, 'c.db'), HANDOVER_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
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

test('9台から一斉に発行しても、引渡番号が重複しない', async () => {
  const sessions = await Promise.all(Array.from({ length: DESKS }, openSession));

  // 各台が10件ずつ、合計90件を同時に発行する
  const results = await Promise.all(
    sessions.flatMap((call, desk) =>
      Array.from({ length: 10 }, (_, i) =>
        call('/api/handovers', {
          method: 'POST',
          body: { customer_name: `${desk + 1}番PC のお客様${i + 1}`, item_count: 2 },
        })
      )
    )
  );

  assert.ok(results.every((r) => r.status === 201), '発行に失敗したものがある');

  // 引渡票90件 + 荷物ラベル180件、すべて別番号でなければならない
  const listing = await sessions[0]('/api/handovers?limit=200');
  assert.equal(listing.body.summary.total, DESKS * 10, '発行件数が合わない');

  const tokens = new Set(results.map((r) => r.body.handover.token));
  assert.equal(tokens.size, DESKS * 10, '引渡番号が重複している');

  const details = await Promise.all(
    results.map((r) => sessions[0](`/api/handovers/${r.body.handover.id}`))
  );
  for (const d of details) assert.equal(d.body.packages.length, 2);

  const all = new Set([...tokens, ...details.flatMap((d) => d.body.packages.map((p) => p.token))]);
  assert.equal(all.size, DESKS * 30, '荷物ラベルを含めた番号に重複がある');
});

test('同じ荷物を2台が同時に確定しようとしても、1回しか通らない', async () => {
  const [a, b] = await Promise.all([openSession(), openSession()]);

  // 二重渡しが起きうる状況を何度も作って確かめる
  for (let round = 0; round < 20; round++) {
    const created = await a('/api/handovers', {
      method: 'POST',
      body: { customer_name: `競合テスト${round}`, item_count: 1 },
    });
    const id = created.body.handover.id;
    const pkgs = (await a(`/api/handovers/${id}`)).body.packages;
    const payload = {
      method: 'POST',
      body: {
        receiverName: '受取人',
        signature: signature(),
        packageTokens: pkgs.map((p) => p.token),
      },
    };

    const [r1, r2] = await Promise.all([
      a(`/api/handovers/${id}/complete`, payload),
      b(`/api/handovers/${id}/complete`, payload),
    ]);

    const ok = [r1, r2].filter((r) => r.status === 200);
    const rejected = [r1, r2].filter((r) => r.status === 409);
    assert.equal(ok.length, 1, `${round}回目: 成功が${ok.length}件（1件であるべき）`);
    assert.equal(rejected.length, 1, `${round}回目: 二重渡しが弾かれていない`);
    assert.match(rejected[0].body.error, /既に引渡し済み/);

    // 引渡し完了の記録も1件だけであること
    const events = (await a(`/api/handovers/${id}`)).body.events.filter((e) => e.type === 'completed');
    assert.equal(events.length, 1, `${round}回目: 引渡し記録が${events.length}件ある`);
  }
});

test('9台が同時に一覧・検索してもエラーにならない', async () => {
  const sessions = await Promise.all(Array.from({ length: DESKS }, openSession));
  const results = await Promise.all(
    sessions.flatMap((call) => [
      call('/api/handovers?limit=50'),
      call('/api/handovers?q=' + encodeURIComponent('お客様')),
      call('/api/handovers?status=issued'),
    ])
  );
  assert.ok(results.every((r) => r.status === 200), '一覧・検索に失敗したものがある');
});
