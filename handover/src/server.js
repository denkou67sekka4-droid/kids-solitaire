import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { HttpError, json, parseCookies, securityHeaders, send, serveStatic } from './http.js';
import { matchRoute, SESSION_COOKIE } from './routes.js';
import * as store from './db.js';
import { CERT_DIR, HTTP_PORT, HTTPS_PORT, PUBLIC_DIR, certificateCoverage, lanAddresses } from './config.js';
import { hostname } from 'node:os';

/** URL のパスと、実際に返す HTML ファイル */
const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/issue': 'issue.html',
  '/sheet': 'sheet.html',
  '/labels': 'labels.html',
  '/pickup-sheet': 'pickup-sheet.html',
  '/scan': 'scan.html',
  '/list': 'list.html',
  '/detail': 'detail.html',
  '/users': 'users.html',
  '/connect': 'connect.html',
  '/check': 'check.html',
};
// 電波チェックは現場でセッションが切れていても開けるようにする（業務データは出さない）
const PUBLIC_PAGES = new Set(['/login', '/check']);

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

  // 2-0. お客様セルフ受取（/r/<引渡番号>）。
  //      お客様はログインできないので、この画面だけは誰でも開ける。
  //      中身の出し分けは画面側が /api/r/... を叩いて行う。
  if (pathname.startsWith('/r/')) {
    return send(res, 200, 'text/html; charset=utf-8', readFileSync(resolve(PUBLIC_DIR, 'receive.html')), {
      'cache-control': 'no-cache',
    });
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

function start() {
  ensureAdmin();
  store.purgeExpiredSessions();
  setInterval(() => store.purgeExpiredSessions(), 6 * 3600_000).unref();

  const creds = loadCertificate();
  const addrs = lanAddresses();
  const host = hostname();

  const http = createHttpServer(listener({ https: false }));

  // HTTPが塞がっていたら業務そのものが成立しないので、理由を出して終わる。
  // 既定のまま何も言わずに落ちると、原因にたどり着けない。
  http.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[!] ポート ${HTTP_PORT} は既に使われています。\n` +
        '    このアプリが二重に起動していないか確認してください。\n' +
        `    別のポートを使う場合は、start.bat の PORT を書き換えてください。\n`
      );
      process.exit(1);
    }
    throw err;
  });

  http.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HTTP  : http://localhost:${HTTP_PORT}`);
    // 他のPCからはコンピュータ名で開いてもらうほうがよい。
    // 社内DHCPでIPが変わってもブックマークが切れないため、先に出す。
    if (host && host !== 'localhost') {
      console.log(`        http://${host}:${HTTP_PORT}   ← 他のPCはこちら`);
    }
    for (const a of addrs) console.log(`        http://${a}:${HTTP_PORT}`);
  });

  if (creds) {
    const https = createHttpsServer(creds, listener({ https: true }));

    // HTTPSが立たなくても、番号の手入力での運用は続けられる。
    // ここでアプリごと落とすと、カメラが使えないどころか業務が止まる。
    https.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `\n[!] ポート ${HTTPS_PORT} が使えないため、HTTPSを開始できませんでした。\n` +
          '    スマホのカメラは使えませんが、他の機能はこのまま使えます。\n' +
          '    start.bat の HTTPS_PORT を空いている番号に変えると解消します。\n'
        );
        return;
      }
      console.error('[HTTPS]', err);
    });

    https.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS : https://localhost:${HTTPS_PORT}`);
      for (const a of addrs) console.log(`        https://${a}:${HTTPS_PORT}   ← スマホはこちら`);

      // ネットワークが変わってIPが変わると、証明書に書いていないアドレスになる。
      // 黙って「スマホでカメラが使えない」状態になるので、ここで気づけるようにする。
      const { missing } = certificateCoverage();
      if (missing.length) {
        console.log(
          `\n[!] このPCのアドレス（${missing.join(', ')}）が証明書に入っていません。\n` +
          '    ネットワークが変わったか、IPが変わった可能性があります。\n' +
          '    このままではスマホでカメラが使えません。\n' +
          '    make-cert.bat をダブルクリックして作り直してください。\n'
        );
      }
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
