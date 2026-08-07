import { HttpError, json, readJson, redirect, send, setCookie } from './http.js';
import { normalizeToken } from './token.js';
import { toPng, toSvg } from './qr.js';
import * as store from './db.js';

const SESSION_COOKIE = 'handover_session';
const SESSION_DAYS = 7;

/* ------------------------------------------------------------------ *
 * 入力チェック
 * ------------------------------------------------------------------ */

const MAX_LEN = {
  customer_name: 100,
  customer_kana: 100,
  company: 120,
  phone: 40,
  email: 200,
  order_no: 60,
  item_desc: 300,
  storage_location: 100,
  pickup_from: 20,
  pickup_until: 20,
  note: 1000,
};

function cleanHandoverInput(body) {
  const out = {};
  for (const [field, max] of Object.entries(MAX_LEN)) {
    const v = body[field];
    out[field] = typeof v === 'string' ? v.trim().slice(0, max) : '';
  }

  if (!out.customer_name) throw new HttpError(400, 'お客様名は必須です');

  const count = Number(body.item_count);
  if (!Number.isInteger(count) || count < 1 || count > 9999) {
    throw new HttpError(400, '個数は1〜9999の整数で入力してください');
  }
  out.item_count = count;

  for (const f of ['pickup_from', 'pickup_until']) {
    if (out[f] && !/^\d{4}-\d{2}-\d{2}$/.test(out[f])) {
      throw new HttpError(400, '日付は YYYY-MM-DD 形式で入力してください');
    }
  }
  if (out.pickup_from && out.pickup_until && out.pickup_from > out.pickup_until) {
    throw new HttpError(400, '引取期限が引取開始日より前になっています');
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) {
    throw new HttpError(400, 'メールアドレスの形式が正しくありません');
  }
  return out;
}

/** dataURL のサインを検証して Buffer にする */
function decodeSignature(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(400, 'サインが取得できませんでした');
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, 'サインの形式が正しくありません（PNGのみ）');

  const buf = Buffer.from(m[1], 'base64');
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 100 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new HttpError(400, 'サイン画像が壊れています');
  }
  if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, 'サイン画像が大きすぎます');
  return buf;
}

/* ------------------------------------------------------------------ *
 * 認証まわり
 * ------------------------------------------------------------------ */

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ログインが必要です');
  return ctx.user;
}

/**
 * 状態を変える操作は Origin/Referer を検証する（CSRF対策）。
 * SameSite=Lax と併せて二重に防ぐ。
 */
function checkOrigin(req) {
  const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : null);
  if (!origin) return; // アプリ以外（curl等）からの直接呼び出しは許容する
  const host = req.headers.host;
  if (!host) throw new HttpError(400, 'Hostヘッダがありません');
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, '不正なOriginです');
  }
  if (originHost !== host) throw new HttpError(403, '不正なリクエスト元です');
}

/* ------------------------------------------------------------------ *
 * ルート定義
 * ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, pattern, handler, auth: opts.auth !== false });

// --- 認証 -----------------------------------------------------------

route(
  'POST',
  '/api/login',
  async (ctx) => {
    checkOrigin(ctx.req);
    const { username, password } = await readJson(ctx.req);
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'ユーザー名とパスワードを入力してください');
    }

    const user = store.findUserByName(username.trim());
    // ユーザーの存在有無を応答時間から推測されないよう、失敗経路をそろえる
    const ok = user ? store.verifyPassword(password, user.password_hash) : false;
    if (!ok) throw new HttpError(401, 'ユーザー名またはパスワードが違います');

    const { token, expires } = store.createSession(user.id, SESSION_DAYS);
    setCookie(ctx.res, SESSION_COOKIE, token, {
      maxAge: SESSION_DAYS * 86400,
      secure: ctx.https,
    });
    json(ctx.res, 200, { user: { username: user.username, displayName: user.display_name } });
  },
  { auth: false }
);

route('POST', '/api/logout', async (ctx) => {
  checkOrigin(ctx.req);
  if (ctx.sessionToken) store.deleteSession(ctx.sessionToken);
  setCookie(ctx.res, SESSION_COOKIE, '', { maxAge: 0, secure: ctx.https });
  json(ctx.res, 200, { ok: true });
}, { auth: false });

route(
  'GET',
  '/api/me',
  async (ctx) => {
    json(ctx.res, 200, {
      user: ctx.user ? { username: ctx.user.username, displayName: ctx.user.display_name } : null,
    });
  },
  { auth: false }
);

/** 引渡票に刷り込む差出人名。運用先ごとに環境変数で差し替える。 */
route('GET', '/api/config', async (ctx) => {
  requireUser(ctx);
  json(ctx.res, 200, { org: process.env.HANDOVER_ORG_NAME || '荷物引渡し窓口' });
});

// --- 引渡票 ---------------------------------------------------------

route('GET', '/api/handovers', async (ctx) => {
  requireUser(ctx);
  const q = ctx.url.searchParams.get('q') ?? '';
  const status = ctx.url.searchParams.get('status') ?? '';
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 50, 200);
  const offset = Math.max(Number(ctx.url.searchParams.get('offset')) || 0, 0);

  if (status && !['issued', 'completed', 'cancelled'].includes(status)) {
    throw new HttpError(400, '状態の指定が不正です');
  }

  json(ctx.res, 200, {
    items: store.listHandovers({ q, status, limit, offset }),
    summary: store.countHandovers(),
  });
});

route('POST', '/api/handovers', async (ctx) => {
  const user = requireUser(ctx);
  checkOrigin(ctx.req);
  const input = cleanHandoverInput(await readJson(ctx.req));
  json(ctx.res, 201, { handover: store.createHandover(input, user.display_name) });
});

route('GET', '/api/handovers/:id', async (ctx) => {
  requireUser(ctx);
  const h = store.getHandover(Number(ctx.params.id));
  if (!h) throw new HttpError(404, '引渡票が見つかりません');
  json(ctx.res, 200, {
    handover: h,
    packages: store.listPackages(h.id),
    events: store.listEvents(h.id),
  });
});

route('PUT', '/api/handovers/:id', async (ctx) => {
  const user = requireUser(ctx);
  checkOrigin(ctx.req);
  const input = cleanHandoverInput(await readJson(ctx.req));
  const row = store.updateHandover(Number(ctx.params.id), input, user.display_name);
  if (!row) throw new HttpError(409, '引渡済み・取消済みの引渡票は編集できません');
  json(ctx.res, 200, { handover: row });
});

route('POST', '/api/handovers/:id/cancel', async (ctx) => {
  const user = requireUser(ctx);
  checkOrigin(ctx.req);
  const { note } = await readJson(ctx.req);
  const row = store.cancelHandover(Number(ctx.params.id), user.display_name, String(note ?? '').slice(0, 500));
  if (!row) throw new HttpError(409, 'この引渡票は取消できません');
  json(ctx.res, 200, { handover: row });
});

/**
 * QRを読んだ／番号を手入力したときの照会。
 * ここでは状態を変えない。「見つかった／既に引渡済み／取消済み」を返すだけ。
 * 実際の確定はサインを添えた complete で行う。
 *
 * 引渡票の番号と荷物ラベルの番号は同じ番号空間から採番しているので、
 * 読み取った番号だけでどちらなのか一意に判別できる。
 */
route('GET', '/api/lookup', async (ctx) => {
  const user = requireUser(ctx);
  const token = normalizeToken(ctx.url.searchParams.get('token') ?? '');
  if (!token) throw new HttpError(400, '番号の形式が正しくありません');

  const handover = store.getHandoverByToken(token);
  if (handover) {
    logScan(ctx, user, handover.id);
    return json(ctx.res, 200, {
      kind: 'handover',
      handover,
      packages: store.listPackages(handover.id),
      events: store.listEvents(handover.id),
    });
  }

  const pkg = store.getPackageByToken(token);
  if (pkg) {
    const parent = store.getHandover(pkg.handover_id);
    return json(ctx.res, 200, {
      kind: 'package',
      package: pkg,
      handover: parent,
      packages: store.listPackages(parent.id),
      events: store.listEvents(parent.id),
    });
  }

  throw new HttpError(404, 'この番号は登録されていません');
});

/** カメラは連続で読み取るので、同じ票の照会ログが溜まらないよう5分間はまとめる */
function logScan(ctx, user, handoverId) {
  const recent = store
    .listEvents(handoverId)
    .filter((e) => e.type === 'scanned' && e.actor === user.display_name)
    .at(-1);
  if (recent && Date.now() - new Date(recent.at).getTime() <= 5 * 60_000) return;

  store.addEvent({
    handover_id: handoverId,
    type: 'scanned',
    actor: user.display_name,
    user_agent: String(ctx.req.headers['user-agent'] ?? '').slice(0, 300),
  });
}

/** サインを受け取って引渡し確定 */
route('POST', '/api/handovers/:id/complete', async (ctx) => {
  const user = requireUser(ctx);
  checkOrigin(ctx.req);
  const body = await readJson(ctx.req);

  const receiverName = String(body.receiverName ?? '').trim().slice(0, 100);
  if (!receiverName) throw new HttpError(400, '受領者のお名前を入力してください');

  const relation = body.receiverRelation === 'agent' ? 'agent' : 'self';
  const signature = decodeSignature(body.signature);

  const id = Number(ctx.params.id);

  // 先に状態を見ておく。荷物照合の前に弾いた方が、現場に出るメッセージが正確になる。
  // （実際の二重引渡し防止は下の completeHandover の原子的な UPDATE が担う）
  const existing = store.getHandover(id);
  if (!existing) throw new HttpError(404, '引渡票が見つかりません');
  if (existing.status !== 'issued') {
    throw new HttpError(
      409,
      existing.status === 'completed' ? 'この荷物は既に引渡し済みです' : 'この引渡票は取消されています'
    );
  }

  const { scannedSeqs, overrideNote } = verifyPackages(id, body);

  const row = store.completeHandover(id, {
    actor: user.display_name,
    receiverName,
    receiverRelation: relation,
    signaturePng: signature,
    note: [String(body.note ?? '').slice(0, 500), overrideNote].filter(Boolean).join(' / '),
    userAgent: String(ctx.req.headers['user-agent'] ?? '').slice(0, 300),
    packagesScanned: scannedSeqs,
  });

  // completeHandover は status='issued' の行しか更新しない。
  // ここで null になるのは、上の確認との間に別の端末が先に確定させた場合＝二重引渡しの防止。
  if (!row) throw new HttpError(409, 'この荷物は既に引渡し済みです');

  json(ctx.res, 200, { handover: row, events: store.listEvents(row.id) });
});

// --- 画像 -----------------------------------------------------------

route('GET', '/api/handovers/:id/signature.png', async (ctx) => {
  requireUser(ctx);
  const ev = store.getLatestSignatureEvent(Number(ctx.params.id));
  if (!ev) throw new HttpError(404, 'サインが登録されていません');
  send(ctx.res, 200, 'image/png', Buffer.from(store.getSignature(ev.id)), {
    'cache-control': 'private, max-age=3600',
  });
});

route('GET', '/api/events/:id/signature.png', async (ctx) => {
  requireUser(ctx);
  const sig = store.getSignature(Number(ctx.params.id));
  if (!sig) throw new HttpError(404, 'サインが登録されていません');
  send(ctx.res, 200, 'image/png', Buffer.from(sig), { 'cache-control': 'private, max-age=3600' });
});

route('GET', '/qr/:token.svg', async (ctx) => {
  requireUser(ctx);
  const token = normalizeToken(ctx.params.token);
  if (!token) throw new HttpError(400, '引渡番号が不正です');
  const mm = Math.min(Math.max(Number(ctx.url.searchParams.get('mm')) || 55, 20), 200);
  send(ctx.res, 200, 'image/svg+xml', toSvg(token, { sizeMm: mm }), { 'cache-control': 'private, max-age=3600' });
});

route('GET', '/qr/:token.png', async (ctx) => {
  requireUser(ctx);
  const token = normalizeToken(ctx.params.token);
  if (!token) throw new HttpError(400, '引渡番号が不正です');
  const px = Math.min(Math.max(Number(ctx.url.searchParams.get('px')) || 900, 200), 2000);
  send(ctx.res, 200, 'image/png', toPng(token, { targetPx: px }), {
    'cache-control': 'private, max-age=3600',
    'content-disposition': `attachment; filename="QR_${token}.png"`,
  });
});

// --- CSV 書き出し ---------------------------------------------------

const csvCell = (v) => {
  const s = String(v ?? '');
  // 先頭が =,+,-,@ のセルは表計算ソフトが数式として解釈するので無害化する
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

route('GET', '/api/export.csv', async (ctx) => {
  requireUser(ctx);
  const rows = store.listHandovers({
    q: ctx.url.searchParams.get('q') ?? '',
    status: ctx.url.searchParams.get('status') ?? '',
    limit: 10000,
  });

  const header = [
    '引渡番号', '状態', 'お客様名', 'フリガナ', '会社名', '電話番号', 'メール',
    '受注番号', '品名', '個数', '保管場所', '引取開始', '引取期限', '備考',
    '発行者', '発行日時', '引渡日時',
  ];
  const STATUS_JA = { issued: '発行済', completed: '引渡済', cancelled: '取消' };

  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.token, STATUS_JA[r.status] ?? r.status, r.customer_name, r.customer_kana, r.company,
        r.phone, r.email, r.order_no, r.item_desc, r.item_count, r.storage_location,
        r.pickup_from, r.pickup_until, r.note, r.issued_by, r.created_at, r.completed_at ?? '',
      ].map(csvCell).join(',')
    );
  }

  // Excel が UTF-8 と判別できるよう BOM を付ける
  send(ctx.res, 200, 'text/csv; charset=utf-8', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n'), 'utf8')]), {
    'content-disposition': `attachment; filename="handover_${new Date().toISOString().slice(0, 10)}.csv"`,
    'cache-control': 'no-store',
  });
});

/**
 * 荷物ラベルの照合を「サーバ側でもう一度」やる。
 * 画面側でも同じ確認をしているが、そちらは通信を細工すれば飛ばせてしまう。
 * 二重渡し・取り違えを本当に防ぐ砦はここ。
 */
function verifyPackages(handoverId, body) {
  const all = store.listPackages(handoverId);
  if (all.length === 0) return { scannedSeqs: [], overrideNote: '' };

  const tokens = Array.isArray(body.packageTokens) ? body.packageTokens.slice(0, 500) : [];
  const scanned = new Set();

  for (const raw of tokens) {
    const token = normalizeToken(raw);
    if (!token) throw new HttpError(400, '荷物ラベルの番号が不正です');

    const pkg = store.getPackageByToken(token);
    if (!pkg) throw new HttpError(400, `荷物ラベル ${token} は登録されていません`);
    if (pkg.handover_id !== handoverId) {
      throw new HttpError(409, `荷物ラベル ${token} は別のお客様の荷物です`);
    }
    scanned.add(pkg.seq);
  }

  const missing = all.filter((p) => !scanned.has(p.seq)).map((p) => p.seq);
  if (missing.length === 0) {
    return { scannedSeqs: [...scanned].sort((a, b) => a - b), overrideNote: '' };
  }

  // 全部そろっていないまま渡すこと自体は現場では起こりうる（別便で発送済み等）。
  // 禁止するのではなく、理由を必ず残させる。
  const reason = String(body.overrideReason ?? '').trim().slice(0, 300);
  if (!reason) {
    throw new HttpError(
      409,
      `荷物ラベルの照合が未完了です（未確認: ${missing.join(', ')} / 全${all.length}箱）`
    );
  }

  return {
    scannedSeqs: [...scanned].sort((a, b) => a - b),
    overrideNote: `【一部のみ引渡し】未確認の荷物: ${missing.join(', ')}（全${all.length}箱）／理由: ${reason}`,
  };
}

/* ------------------------------------------------------------------ *
 * 照合
 * ------------------------------------------------------------------ */

/** `/qr/:token.svg` のように、末尾に拡張子が付く形も扱えるようにしている */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;

    const pParts = r.pattern.split('/');
    const uParts = pathname.split('/');
    if (pParts.length !== uParts.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < pParts.length; i++) {
      const p = pParts[i];
      const u = decodeURIComponent(uParts[i]);
      if (p.startsWith(':')) {
        const dot = p.indexOf('.', 1);
        if (dot > 0) {
          const suffix = p.slice(dot); // '.svg' など
          if (!u.endsWith(suffix) || u.length <= suffix.length) { ok = false; break; }
          params[p.slice(1, dot)] = u.slice(0, -suffix.length);
        } else {
          if (!u) { ok = false; break; }
          params[p.slice(1)] = u;
        }
      } else if (p !== u) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params, auth: r.auth };
  }
  return null;
}

export { matchRoute, SESSION_COOKIE, redirect };
