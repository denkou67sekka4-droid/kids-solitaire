import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { HttpError, json, parseCookies, securityHeaders, send, serveStatic } from './http.js';
import { matchRoute, SESSION_COOKIE } from './routes.js';
import * as store from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const CERT_DIR = resolve(__dirname, '..', 'certs');

const HTTP_PORT = Number(process.env.PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;

/** URL のパスと、実際に返す HTML ファイル */
const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/issue': 'issue.html',
  '/sheet': 'sheet.html',
  '/labels': 'labels.html',
  '/scan': 'scan.html',
  '/list': 'list.html',
  '/detail': 'detail.html',
  '/users': 'users.html',
};
const PUBLIC_PAGES = new Set(['/login']);

/* ------------------------------------------------------------------ *
 * 初回起動時の管理者アカウント作成
 * ------------------------------------------------------------------ */
function ensureAdmin() {
  if (store.countUsers() > 0) return;

  const password = process.env.HANDOVER_ADMIN_PASSWORD || store.generatePassword();
  store.createUser({ username: 'admin', password, displayName: '管理者', isAdmin: true });

  console.log('\n' + '='.repeat(62));
  console.log('  初回起動: 管理者アカウントを作成しました');
  console.log('    ユーザー名 : admin');
  console.log(`    パスワード : ${password}`);
  if (!process.env.HANDOVER_ADMIN_PASSWORD) {
    console.log('  ※ この表示は一度きりです。控えてください。');
  }
  console.log('='.repeat(62) + '\n');
}

/* ------------------------------------------------------------------ *
 * リクエスト処理
 * ------------------------------------------------------------------ */
async function handle(req, res, { https }) {
  securityHeaders(res, { https });

  const url = new URL(req.url, `http${https ? 's' : ''}://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  const cookies = parseCookies(req);
  const sessionToken = cookies[SESSION_COOKIE] ?? null;
  const user = store.findSessionUser(sessionToken);
  const ctx = { req, res, url, params: {}, user, sessionToken, https };

  // 1. API / 画像などのルート
  const matched = matchRoute(req.method, pathname);
  if (matched) {
    ctx.params = matched.params;
    return matched.handler(ctx);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, '許可されていないメソッドです');
  }

  // 2. HTML ページ
  const page = PAGES[pathname];
  if (page) {
    if (!user && !PUBLIC_PAGES.has(pathname)) {
      res.writeHead(302, {
        location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
        'cache-control': 'no-store',
      });
      return res.end();
    }
    // ログイン済みでログイン画面に来たらメニューへ戻す
    if (user && pathname === '/login') {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }
    return send(res, 200, 'text/html; charset=utf-8', readFileSync(resolve(PUBLIC_DIR, page)), {
      'cache-control': 'no-cache',
    });
  }

  // 3. 静的ファイル
  if (serveStatic(req, res, PUBLIC_DIR, pathname)) return;

  throw new HttpError(404, 'ページが見つかりません');
}

function listener(opts) {
  return (req, res) => {
    handle(req, res, opts).catch((err) => {
      if (res.headersSent) return res.destroy();
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[${req.method} ${req.url}]`, err);

      const message = status >= 500 ? 'サーバ内部でエラーが発生しました' : err.message;
      if (req.headers.accept?.includes('text/html')) {
        send(res, status, 'text/html; charset=utf-8',
          `<!doctype html><meta charset="utf-8"><title>${status}</title>` +
          `<body style="font-family:system-ui;padding:2rem;line-height:1.8">` +
          `<h1>${status}</h1><p>${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</p>` +
          `<p><a href="/">メニューに戻る</a></p>`);
      } else {
        json(res, status, { error: message });
      }
    });
  };
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */
/**
 * HTTPS用の証明書を読む。
 * Windowsは PowerShell が PFX 形式でしか書き出せないので、両方に対応しておく。
 * 見つからなければ null（HTTPは動かし続ける）。
 */
function loadCertificate() {
  const pfx = resolve(CERT_DIR, 'server.pfx');
  const pass = resolve(CERT_DIR, 'server.pfx.pass');
  if (existsSync(pfx)) {
    return {
      pfx: readFileSync(pfx),
      passphrase: existsSync(pass) ? readFileSync(pass, 'utf8').trim() : undefined,
    };
  }

  const key = resolve(CERT_DIR, 'server.key');
  const crt = resolve(CERT_DIR, 'server.crt');
  if (existsSync(key) && existsSync(crt)) {
    return { key: readFileSync(key), cert: readFileSync(crt) };
  }

  return null;
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

function start() {
  ensureAdmin();
  store.purgeExpiredSessions();
  setInterval(() => store.purgeExpiredSessions(), 6 * 3600_000).unref();

  const creds = loadCertificate();
  const addrs = lanAddresses();

  createHttpServer(listener({ https: false })).listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HTTP  : http://localhost:${HTTP_PORT}`);
    for (const a of addrs) console.log(`        http://${a}:${HTTP_PORT}`);
  });

  if (creds) {
    createHttpsServer(creds, listener({ https: true })).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS : https://localhost:${HTTPS_PORT}`);
      for (const a of addrs) console.log(`        https://${a}:${HTTPS_PORT}   ← スマホはこちら`);
    });
  } else {
    console.log(
      '\n[!] HTTPS証明書がないため、スマホのカメラは使えません。\n' +
      '    ブラウザはHTTPS以外でカメラを許可しません（localhostを除く）。\n' +
      '    `npm run cert` で証明書を作ってから起動し直してください。\n' +
      '    ※ 証明書なしでも、引渡番号の手入力での運用は可能です。\n'
    );
  }
}

start();
