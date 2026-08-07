import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MAX_BODY = 4 * 1024 * 1024; // サイン画像(PNG)が乗るので少し大きめ

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function send(res, status, contentType, body, extraHeaders = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

export function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

export async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new HttpError(413, 'データが大きすぎます');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSONの形式が正しくありません');
  }
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, expires, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  if (expires) c += `; Expires=${new Date(expires).toUTCString()}`;

  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', prev ? [].concat(prev, c) : [c]);
}

/**
 * public/ 配下の静的ファイル配信。
 * `..` を含むパスでルート外に出られないよう、解決後のパスを必ず検査する。
 */
export function serveStatic(req, res, rootDir, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const full = resolve(join(rootDir, rel));
  if (full !== rootDir && !full.startsWith(rootDir + sep)) throw new HttpError(403, 'アクセスできません');

  let st;
  try {
    st = statSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
  const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    etag,
    // 画面ファイルは更新をすぐ反映したいので毎回検証させる
    'cache-control': 'no-cache',
  });
  createReadStream(full).pipe(res);
  return true;
}

export function securityHeaders(res, { https }) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  if (https) res.setHeader('strict-transport-security', 'max-age=31536000');
}
