/**
 * 画面まで含めた通しテスト。
 *
 * 実際のChromiumを起動し、カメラには「本物のQRを写した映像」を流し込んで
 *   発行 → 引渡票の印刷面 → 荷物ラベル → お客様QR読取 → 荷物QR読取 → サイン → 確定
 * を人手を介さずに一周させる。
 *
 * カメラ映像は Chromium の --use-file-for-fake-video-capture に
 * Y4M ファイルを渡して差し替える。QRごとに区間を分けた1本の動画を作り、
 * 再生が進むにつれて次のQRが写る仕組みにしている。
 *
 *   node scripts/smoke.mjs [--headed] [--keep]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toMatrix } from '../src/qr.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PORT = 17500 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'smoke-password-1234';

const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const SHOTS = join(ROOT, 'screenshots');

const W = 480;
const H = 480;
const FPS = 15;
const FRAMES_PER_QR = 30; // 1つのQRを2秒ぶん写す

/* ------------------------------------------------------------------ *
 * QR を Y4M 動画にする
 * ------------------------------------------------------------------ */

/** QR1枚を W×H の輝度プレーンに描く（中央に配置、余白は白） */
function renderQrToLuma(token) {
  const { rows, size } = toMatrix(token);
  const y = Buffer.alloc(W * H, 0xff); // 白で塗りつぶし

  const scale = Math.floor(Math.min(W, H) * 0.8 / size);
  const dim = size * scale;
  const ox = ((W - dim) / 2) | 0;
  const oy = ((H - dim) / 2) | 0;

  for (let r = 0; r < dim; r++) {
    const srcRow = rows[(r / scale) | 0];
    const base = (oy + r) * W + ox;
    for (let c = 0; c < dim; c++) {
      if (srcRow[(c / scale) | 0]) y[base + c] = 0x00;
    }
  }
  return y;
}

/** 複数のQRを順に写す1本の動画を書き出す */
function writeY4m(path, tokens) {
  const fd = openSync(path, 'w');
  writeSync(fd, Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420\n`, 'ascii'));

  // モノクロなので色差プレーンは中間値（＝無彩色）で固定
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frameHeader = Buffer.from('FRAME\n', 'ascii');

  for (const token of tokens) {
    const luma = renderQrToLuma(token);
    for (let i = 0; i < FRAMES_PER_QR; i++) {
      writeSync(fd, frameHeader);
      writeSync(fd, luma);
      writeSync(fd, chroma);
      writeSync(fd, chroma);
    }
  }
  closeSync(fd);
}

/* ------------------------------------------------------------------ *
 * 補助
 * ------------------------------------------------------------------ */

const log = (msg) => console.log(`  ${msg}`);
let step = 0;
async function shot(page, name, { fullPage = true } = {}) {
  await page.screenshot({ path: join(SHOTS, `${String(++step).padStart(2, '0')}-${name}.png`), fullPage });
}

function assert(cond, message) {
  if (!cond) throw new Error(`✗ ${message}`);
  log(`✓ ${message}`);
}

/**
 * Chromium の場所。
 * 環境に入っているビルドと playwright が期待するビルドがずれていることがあるので、
 * 見つかった実体を優先して使う（CHROMIUM_PATH で明示指定も可）。
 */
function launchOptions(args = []) {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  return { headless: !HEADED, args, ...(found ? { executablePath: found } : {}) };
}

async function startServer(dbPath) {
  const server = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // 証明書がある環境では既定の8443を掴みにいくので、こちらもずらしておく
      HTTPS_PORT: String(PORT + 1),
      HANDOVER_DB: dbPath,
      HANDOVER_ADMIN_PASSWORD: PASSWORD,
      HANDOVER_ORG_NAME: 'スモークテスト運輸株式会社',
      // 時間外セルフ受取のQRに入るアドレス（本番は外から届くURLを設定する）
      HANDOVER_PUBLIC_URL: BASE,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/login`);
      return server;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('サーバが起動しませんでした');
}

/** サイン欄を指でなぞる（画面外だとマウス座標が届かないので必ず表示域に入れる） */
async function sign(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();

  const strokes = [
    [[0.15, 0.35], [0.30, 0.30], [0.45, 0.40], [0.30, 0.55], [0.18, 0.62], [0.34, 0.70]],
    [[0.55, 0.28], [0.72, 0.34], [0.62, 0.52], [0.78, 0.60], [0.60, 0.72]],
  ];
  for (const stroke of strokes) {
    const [sx, sy] = stroke[0];
    await page.mouse.move(box.x + box.width * sx, box.y + box.height * sy);
    await page.mouse.down();
    for (const [px, py] of stroke.slice(1)) {
      await page.mouse.move(box.x + box.width * px, box.y + box.height * py, { steps: 12 });
    }
    await page.mouse.up();
  }
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`);
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

const tmp = mkdtempSync(join(tmpdir(), 'handover-smoke-'));
mkdirSync(SHOTS, { recursive: true });

let server;
let browser;

try {
  server = await startServer(join(tmp, 'smoke.db'));
  log(`サーバ起動: ${BASE}`);

  /* --- 1. 事務PC側: 発行 ------------------------------------------ */
  console.log('\n[1] 事務PCで引渡票を発行する');

  browser = await chromium.launch(launchOptions());
  let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  let page = await ctx.newPage();

  const errors = [];
  ctx.on('weberror', (e) => errors.push({ url: e.page().url(), stack: e.error()?.stack ?? String(e.error()) }));

  await login(page);
  await shot(page, 'menu');

  await page.goto(`${BASE}/issue`);
  await page.fill('#customer_name', '山田 太郎');
  await page.fill('#customer_kana', 'ヤマダ タロウ');
  await page.fill('#company', '株式会社ヤマダ商店');
  await page.fill('#phone', '090-1234-5678');
  await page.fill('#order_no', 'JT-2026-0042');
  await page.fill('#item_desc', '事務机 2台');
  await page.fill('#item_count', '2');
  await page.fill('#storage_location', '第2倉庫 A-12');
  await page.fill('#pickup_until', '2026-12-31');
  await shot(page, 'issue-form');

  await page.click('#submitBtn');
  await page.waitForURL(/\/sheet\?id=/);
  await page.waitForSelector('.qr-block .token');

  const handoverId = new URL(page.url()).searchParams.get('id');
  const customerToken = (await page.textContent('.qr-block .token')).trim();
  assert(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/.test(customerToken),
    `引渡票を発行できた（引渡番号 ${customerToken}）`);
  await shot(page, 'sheet-fax');

  /* --- 2. 荷物ラベル ---------------------------------------------- */
  console.log('\n[2] 荷物ラベルを印刷する');

  await page.goto(`${BASE}/labels?id=${handoverId}`);
  await page.waitForSelector('.label');
  const labelCount = await page.locator('.label').count();
  assert(labelCount === 2, `個数(2)ぶんの荷物ラベルが出た（${labelCount}枚）`);

  const packageTokens = await page.locator('.label-qr .token').allTextContents();
  assert(new Set([customerToken, ...packageTokens]).size === 3, '引渡番号と荷物ラベルの番号が全部ちがう');
  await shot(page, 'labels');

  /* --- 3. 別のお客様の荷物（取り違え検知用） ---------------------- */
  const other = await ctx.request.post(`${BASE}/api/handovers`, {
    data: { customer_name: '鈴木 次郎', item_count: 1 },
    headers: { origin: BASE },
  });
  const otherId = (await other.json()).handover.id;
  const otherPkgs = await (await ctx.request.get(`${BASE}/api/handovers/${otherId}`)).json();
  const wrongToken = otherPkgs.packages[0].token;
  log(`別のお客様(鈴木 次郎 様)の荷物ラベル: ${wrongToken}`);

  await ctx.close();

  /* --- 4. 倉庫のスマホ側: 読み取り → サイン ----------------------- */
  console.log('\n[3] 倉庫のスマホでQRを読み取る');

  // カメラに流す映像: お客様QR → 荷物1 → 荷物2 の順に写る
  const y4m = join(tmp, 'camera.y4m');
  writeY4m(y4m, [customerToken, ...packageTokens.map((t) => t.trim())]);
  log(`偽カメラ映像を用意: ${[customerToken, ...packageTokens].length}種のQR`);

  await browser.close();
  browser = await chromium.launch(launchOptions([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
  ]));

  ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },      // Pixel 相当
    deviceScaleFactor: 2.6,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
    permissions: ['camera'],
  });
  ctx.on('weberror', (e) => errors.push({ url: e.page().url(), stack: e.error()?.stack ?? String(e.error()) }));
  page = await ctx.newPage();

  await login(page);
  await page.goto(`${BASE}/scan`);

  // 手順1: お客様のQR
  await page.waitForSelector('#scanContext .pkg-list', { timeout: 40_000 });
  assert(true, 'カメラでお客様のQRを読み取り、荷物の照合待ちに進んだ');
  assert(await page.locator('.steps li[data-step=packages]').evaluate((n) => n.classList.contains('active')),
    '手順表示が「2. 荷物QR」になっている');
  assert((await page.textContent('#scanContext')).includes('山田 太郎'), 'お客様名が表示されている');
  await shot(page, 'scan-packages');

  // 手順2: 荷物のQR（2箱ぶん）
  await page.waitForSelector('#signStage:not([hidden])', { timeout: 60_000 });
  assert(true, 'カメラで荷物のQRを2箱ぶん読み取り、サイン画面に進んだ');
  assert((await page.textContent('#signPackageSummary')).includes('2 / 2 箱'), '2箱すべて照合済みと表示されている');

  /* --- 5. サイン --------------------------------------------------- */
  console.log('\n[4] 画面にサインをもらう');

  assert((await page.inputValue('#receiverName')) === '山田 太郎',
    'ご本人の場合はお名前が先に入っている');

  await sign(page);
  assert(!(await page.locator('#completeBtn').isDisabled()), 'サインを書くと［引渡しを確定する］が押せるようになった');
  await page.fill('#receiveNote', '1箱に軽微な擦れあり・お客様了承済み');
  await shot(page, 'signature');

  await page.click('#completeBtn');
  await page.waitForSelector('#doneView:not([hidden])', { timeout: 20_000 });
  assert(true, '引渡しを確定できた');
  assert((await page.textContent('#doneSummary')).includes('2/2 箱'), '完了画面に照合結果が出ている');
  await shot(page, 'done');

  /* --- 6. 取り違えの検知 ------------------------------------------ */
  console.log('\n[5] 別のお客様の荷物をかざしたら止まるか');

  // ここは手入力の経路を見たいので、偽カメラ映像を積んでいないブラウザに切り替える。
  // （映像を積んだままだと、ループ再生される先ほどのQRが割り込んでくる）
  await browser.close();
  browser = await chromium.launch(launchOptions());
  ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.6,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
  });
  ctx.on('weberror', (e) => errors.push({ url: e.page().url(), stack: e.error()?.stack ?? String(e.error()) }));
  page = await ctx.newPage();
  await login(page);

  const second = await ctx.request.post(`${BASE}/api/handovers`, {
    data: { customer_name: '佐藤 三郎', item_count: 1 },
    headers: { origin: BASE },
  });
  const secondId = (await second.json()).handover.id;
  const secondData = await (await ctx.request.get(`${BASE}/api/handovers/${secondId}`)).json();

  await page.goto(`${BASE}/scan`);
  await page.waitForSelector('#scanStage:not([hidden])');

  // 手入力の経路も使えることを兼ねて確認する
  await page.fill('#manualToken', secondData.handover.token);
  await page.click('#manualForm button[type=submit]');
  await page.waitForSelector('#scanContext .pkg-list');
  assert(true, '手入力でもお客様を照会できた');

  await page.fill('#manualToken', wrongToken);
  await page.click('#manualForm button[type=submit]');
  await page.waitForSelector('#scanAlert .alert-big.stop');
  const alertText = await page.textContent('#scanAlert');
  assert(alertText.includes('別のお客様の荷物です'), '別のお客様の荷物をかざすと警告が出る');
  assert(alertText.includes('鈴木 次郎'), '誰の荷物なのかが表示される');
  await shot(page, 'mismatch');

  /* --- 6. 代理の方が引き取る場合 ---------------------------------- */
  console.log('\n[6] 代理の方が引き取るとき');

  await page.fill('#manualToken', secondData.packages[0].token);
  await page.click('#manualForm button[type=submit]');
  await page.waitForSelector('#signStage:not([hidden])');

  assert((await page.inputValue('#receiverName')) === '佐藤 三郎',
    '既定ではお客様ご本人の名前が入る');

  await page.selectOption('#receiverRelation', 'agent');
  assert((await page.inputValue('#receiverName')) === '',
    '「代理の方」に切り替えるとお名前が消え、入力し直しになる');
  assert((await page.textContent('#signPrompt')) === '代理でお引取りの方',
    'サインをもらう相手が「代理の方」に変わる');
  await shot(page, 'agent-pickup');

  await page.fill('#receiverName', '山田運送 佐藤');
  await sign(page);
  await page.click('#completeBtn');
  await page.waitForSelector('#doneView:not([hidden])');
  assert(true, '代理の方のサインで引渡しを確定できた');

  /* --- 6b. 続けて次のお客様へ（前の入力が残らないか） -------------- */
  console.log('\n[7] 続けて次のお客様を処理する');

  const third = await ctx.request.post(`${BASE}/api/handovers`, {
    data: { customer_name: '高橋 四郎', item_count: 1 },
    headers: { origin: BASE },
  });
  const thirdData = await (await ctx.request.get(`${BASE}/api/handovers/${(await third.json()).handover.id}`)).json();

  // 画面を再読み込みせず、［続けて次のお客様を読み取る］から続ける
  await page.click('#againBtn');
  await page.waitForSelector('#scanStage:not([hidden])');
  await page.fill('#manualToken', thirdData.handover.token);
  await page.click('#manualForm button[type=submit]');
  await page.waitForSelector('#scanContext .pkg-list');
  await page.fill('#manualToken', thirdData.packages[0].token);
  await page.click('#manualForm button[type=submit]');
  await page.waitForSelector('#signStage:not([hidden])');

  assert((await page.inputValue('#receiverName')) === '高橋 四郎',
    '前のお客様の受領者名が持ち越されていない');
  assert((await page.inputValue('#receiverRelation')) === 'self',
    '続柄が「ご本人」に戻っている');
  assert(await page.locator('#completeBtn').isDisabled(),
    '前のサインが残っておらず、書き直しが必要になっている');

  /* --- 8. カメラが使えないとき ------------------------------------- */
  console.log('\n[8] カメラが使えないときに手入力へ案内できるか');

  const spare = await ctx.request.post(`${BASE}/api/handovers`, {
    data: { customer_name: '渡辺 五郎', item_count: 1 },
    headers: { origin: BASE },
  });
  const spareToken = (await spare.json()).handover.token;

  // HTTPS未設定・権限拒否のときと同じ状態を作る
  const noCam = await ctx.newPage();
  await noCam.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
    });
  });
  await noCam.goto(`${BASE}/scan`);
  await noCam.waitForFunction(
    () => !document.getElementById('scannerMsg').textContent.includes('準備しています')
  );
  const camMsg = await noCam.textContent('#scannerMsg');
  assert(camMsg.includes('カメラの使用が許可されていません'), 'カメラが使えない理由が画面に出る');

  // この状態でも運用できることが大事
  await noCam.fill('#manualToken', spareToken);
  await noCam.click('#manualForm button[type=submit]');
  await noCam.waitForSelector('#scanContext .pkg-list');
  assert(true, 'カメラなしでも手入力で引渡し作業を続けられる');
  await shot(noCam, 'no-camera', { fullPage: false });
  await noCam.close();

  /* --- 7. 事務PCで履歴を確認 -------------------------------------- */
  console.log('\n[9] 事務PCで履歴とサインを確認する');

  const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
  deskCtx.on('weberror', (e) => errors.push({ url: e.page().url(), stack: e.error()?.stack ?? String(e.error()) }));
  const desk = await deskCtx.newPage();
  await login(desk);

  await desk.goto(`${BASE}/detail?id=${handoverId}`);
  await desk.waitForSelector('.sig-box img');
  const sigOk = await desk.locator('.sig-box img').evaluate((img) => img.complete && img.naturalWidth > 0);
  assert(sigOk, 'サイン画像が保存され、表示できる');

  const detailText = await desk.textContent('#content');
  assert(detailText.includes('引渡済'), '状態が引渡済になっている');
  assert(detailText.includes('照合済'), '荷物ラベルの照合結果が残っている');
  await shot(desk, 'detail');

  await desk.goto(`${BASE}/list`);
  await desk.waitForSelector('tbody tr');
  await shot(desk, 'list');

  /* --- 10. 担当者アカウントの管理 ---------------------------------- */
  console.log('\n[10] 事務9名ぶんのアカウントを配る');

  await desk.goto(`${BASE}/`);
  await desk.waitForSelector('#usersLink:not([hidden])');
  assert(true, '管理者のメニューに［担当者の管理］が出る');

  await desk.goto(`${BASE}/users`);
  await desk.waitForSelector('#addForm');
  await desk.fill('#displayName', '田中');
  await desk.fill('#username', 'tanaka');
  await desk.click('#addBtn');
  await desk.waitForSelector('.password-box');

  const issuedPassword = (await desk.textContent('.password-box .value')).trim();
  assert(issuedPassword.length >= 12, `パスワードが発行され画面に出る（${issuedPassword.length}文字）`);
  await shot(desk, 'users');

  // 配ったアカウントで実際にログインできるか
  const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  staffCtx.on('weberror', (e) => errors.push({ url: e.page().url(), stack: e.error()?.stack ?? String(e.error()) }));
  const staff = await staffCtx.newPage();
  await staff.goto(`${BASE}/login`);
  await staff.fill('#username', 'tanaka');
  await staff.fill('#password', issuedPassword);
  await staff.click('button[type=submit]');
  await staff.waitForURL(`${BASE}/`);
  assert(true, '配ったアカウントでログインできる');

  await staff.waitForSelector('.appbar .who');
  assert((await staff.textContent('.appbar .who')) === '田中', '画面に自分の表示名が出る');
  assert(await staff.locator('#usersLink').isHidden(), '担当者には［担当者の管理］が出ない');

  // 発行者が記録に残るか
  await staff.goto(`${BASE}/issue`);
  await staff.fill('#customer_name', '発行者テスト');
  await staff.click('#submitBtn');
  await staff.waitForURL(/\/sheet\?id=/);
  await staff.waitForSelector('.sheet-head .issuer');
  assert((await staff.textContent('.sheet-head .issuer')).includes('田中'),
    '引渡票に発行した担当者名が刷り込まれる');

  /* --- 10b. スマホをつなぐ案内 ------------------------------------- */
  console.log('\n[10b] スマホをつなぐ画面');

  await desk.goto(`${BASE}/connect`);
  await desk.waitForSelector('#content[aria-busy=false]');
  const connText = await desk.textContent('#content');
  assert(connText.includes('同じWi-Fi'), 'スマホの接続手順が出る');

  // 証明書の有無で案内が変わる。どちらの状態でも、次にやることが出ていること。
  const info = await (await desk.request.get(`${BASE}/api/connect`)).json();
  assert(connText.includes('他の事務PCからつなぐ'), '他のPCからの開き方を案内する');
  assert(/http:\/\/[^\s:]+:\d+/.test(connText), '他のPC向けのHTTPアドレスが出ている');
  assert(connText.includes('方法A'), '証明書を使わない簡単な代替手段を案内する');
  assert(connText.includes('飛ばして構いません'), '任意の作業であることを明示する');

  if (info.secure) {
    assert(connText.includes('方法B'), '証明書があるときは導入手順も出す');
    const ca = await desk.request.get(`${BASE}/ca.crt`);
    assert(ca.ok() && (await ca.text()).startsWith('-----BEGIN CERTIFICATE-----'),
      'スマホに入れるCA証明書をダウンロードできる');
  } else {
    assert(connText.includes('カメラが使えません'), '証明書が無いときはカメラが使えない旨を出す');
  }

  const connQr = desk.locator('.conn img').first();
  if (await connQr.count()) {
    assert(await connQr.evaluate((i) => i.complete && i.naturalWidth > 0), '接続用のQRが表示される');
  }
  await shot(desk, 'connect');

  /* --- 11. 時間外のお客様セルフ受取 -------------------------------- */
  console.log('\n[11] 時間外にお客様がご自分で受け取る');

  const night = await deskCtx.request.post(`${BASE}/api/handovers`, {
    data: { customer_name: '夜間 太郎', company: '夜間商事', item_desc: '棚 2台', item_count: 2,
            phone: '090-9999-8888', email: 'yakan@example.com' },
    headers: { origin: BASE },
  });
  const nightId = (await night.json()).handover.id;

  // 事務がワゴンに置く紙を印刷する
  await desk.goto(`${BASE}/pickup-sheet?id=${nightId}`);
  await desk.waitForSelector('.pickup-qr img');
  assert(await desk.locator('#warn .note.danger').isHidden(), 'URLが設定されていれば警告は出ない');
  await shot(desk, 'pickup-sheet');

  const nightToken = (await desk.textContent('.pickup-foot span')).trim();

  // お客様のスマホ（ログインしていない・社外の端末を想定）
  const guestCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
  });
  guestCtx.on('weberror', (e) => errors.push({ url: e.page().url(), stack: e.error()?.stack ?? String(e.error()) }));
  const guest = await guestCtx.newPage();

  await guest.goto(`${BASE}/r/${nightToken}`);
  await guest.waitForSelector('.goods');
  assert(true, 'ログインなしで受取画面が開く');

  const shown = await guest.textContent('#content');
  assert(shown.includes('夜間 太郎') && shown.includes('棚 2台'), '受け取る品物が表示される');
  assert(!shown.includes('090-9999-8888') && !shown.includes('yakan@example.com'),
    'お客様の画面に電話番号・メールを出していない');
  await shot(guest, 'receive-confirm');

  await guest.click('#toSign');
  await guest.waitForSelector('#signCanvas');
  await sign(guest);
  assert(!(await guest.locator('#submitBtn').isDisabled()), 'サインを書くと確定ボタンが押せる');
  await shot(guest, 'receive-sign');

  await guest.click('#submitBtn');
  await guest.waitForSelector('.done-mark');
  assert((await guest.textContent('#content')).includes('送り状はお忘れなく'),
    '完了画面で送り状の持ち帰りを案内する');
  await shot(guest, 'receive-done');

  // 二度目は受け取れない
  await guest.goto(`${BASE}/r/${nightToken}`);
  await guest.waitForSelector('.big-message');
  assert((await guest.textContent('.big-message')).includes('お受け取り済み'),
    '受け取り済みの番号を開くとその旨が出る');

  // 事務側から見ると、日中の引渡しと区別できる
  await desk.goto(`${BASE}/detail?id=${nightId}`);
  await desk.waitForSelector('.sig-box img');
  const nightDetail = await desk.textContent('#content');
  assert(nightDetail.includes('時間外・お客様セルフ受取'), '時間外セルフ受取として記録されている');
  assert(nightDetail.includes('係員による荷物の照合'), '照合を経ていないことが明記されている');
  await shot(desk, 'detail-self-received');

  /* --- 結果 -------------------------------------------------------- */
  if (errors.length) {
    console.error('\n画面側でエラーが発生しました:');
    for (const e of errors) console.error(`  - [${e.url}]\n    ${e.stack.replace(/\n/g, '\n    ')}`);
    throw new Error('JavaScriptエラーあり');
  }

  console.log(`\n✅ 通しテスト成功（スクリーンショット: ${SHOTS}）`);
} finally {
  await browser?.close();
  server?.kill();
  if (!KEEP) rmSync(tmp, { recursive: true, force: true });
}
