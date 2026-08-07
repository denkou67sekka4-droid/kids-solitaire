import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { generateToken } from './token.js';

const DB_PATH = resolve(process.env.HANDOVER_DB ?? 'data/handover.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS handovers (
    id               INTEGER PRIMARY KEY,
    token            TEXT    NOT NULL UNIQUE,
    status           TEXT    NOT NULL DEFAULT 'issued',   -- issued | completed | cancelled

    customer_name    TEXT    NOT NULL,
    customer_kana    TEXT    NOT NULL DEFAULT '',
    company          TEXT    NOT NULL DEFAULT '',
    phone            TEXT    NOT NULL DEFAULT '',
    email            TEXT    NOT NULL DEFAULT '',

    order_no         TEXT    NOT NULL DEFAULT '',
    item_desc        TEXT    NOT NULL DEFAULT '',
    item_count       INTEGER NOT NULL DEFAULT 1,
    storage_location TEXT    NOT NULL DEFAULT '',
    pickup_from      TEXT    NOT NULL DEFAULT '',
    pickup_until     TEXT    NOT NULL DEFAULT '',
    note             TEXT    NOT NULL DEFAULT '',

    issued_by        TEXT    NOT NULL DEFAULT '',
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    completed_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_handovers_status  ON handovers(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_handovers_created ON handovers(created_at DESC);

  -- 荷物ラベル。個数ぶん発行し、1箱に1枚貼る。
  -- 引取り時にお客様のQRと突き合わせることで「別のお客様の荷物を渡す」事故を防ぐ。
  CREATE TABLE IF NOT EXISTS packages (
    id          INTEGER PRIMARY KEY,
    handover_id INTEGER NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,          -- 1 から始まる通し番号（1/3, 2/3 の分子）
    token       TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL,
    UNIQUE (handover_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_packages_handover ON packages(handover_id, seq);

  -- 引渡票に起きたことは全部ここに追記していく。行の更新・削除はしない。
  CREATE TABLE IF NOT EXISTS events (
    id                INTEGER PRIMARY KEY,
    handover_id       INTEGER NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
    type              TEXT    NOT NULL,   -- issued | scanned | completed | cancelled | edited
    at                TEXT    NOT NULL,
    actor             TEXT    NOT NULL DEFAULT '',
    receiver_name     TEXT    NOT NULL DEFAULT '',
    receiver_relation TEXT    NOT NULL DEFAULT '',
    signature_png     BLOB,
    note              TEXT    NOT NULL DEFAULT '',
    user_agent        TEXT    NOT NULL DEFAULT '',
    record_hash       TEXT    NOT NULL DEFAULT '',
    packages_scanned  TEXT    NOT NULL DEFAULT ''  -- 照合した荷物ラベルの通し番号（JSON配列）
  );

  CREATE INDEX IF NOT EXISTS idx_events_handover ON events(handover_id, id);

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

/** 旧バージョンのDBを開いたときに、足りない列だけ足す */
function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('events', 'packages_scanned', "TEXT NOT NULL DEFAULT ''");

export const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * 認証
 * ------------------------------------------------------------------ */

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function createUser({ username, password, displayName = '' }) {
  return db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, created_at)
       VALUES (?, ?, ?, ?) RETURNING id, username, display_name`
    )
    .get(username, displayName || username, hashPassword(password), nowIso());
}

export const findUserByName = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username);

export const countUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

export function createSession(userId, days = 7) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + days * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    nowIso(),
    expires
  );
  return { token, expires };
}

export function findSessionUser(token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.username, u.display_name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(token, nowIso()) ?? null
  );
}

export const deleteSession = (token) =>
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);

export const purgeExpiredSessions = () =>
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());

/* ------------------------------------------------------------------ *
 * 引渡票
 * ------------------------------------------------------------------ */

const HANDOVER_FIELDS = [
  'customer_name',
  'customer_kana',
  'company',
  'phone',
  'email',
  'order_no',
  'item_desc',
  'item_count',
  'storage_location',
  'pickup_from',
  'pickup_until',
  'note',
];

/**
 * 引渡時点の内容を固定するためのハッシュ。
 * 「サインをもらった後で中身を書き換えた」を後から検出できるようにしておく。
 */
export function recordHash(h) {
  const canonical = JSON.stringify([h.token, ...HANDOVER_FIELDS.map((f) => String(h[f] ?? ''))]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * 引渡票と荷物ラベルで番号空間を共有する。
 * こうしておくと「読み取った番号がどちらのものか」を番号だけで一意に判定でき、
 * 取り違えが起きない。
 */
function newUniqueToken() {
  for (let i = 0; i < 20; i++) {
    const token = generateToken();
    const taken =
      db.prepare('SELECT 1 FROM handovers WHERE token = ?').get(token) ??
      db.prepare('SELECT 1 FROM packages WHERE token = ?').get(token);
    if (!taken) return token;
  }
  throw new Error('番号の発行に失敗しました');
}

/** 個数ぶんの荷物ラベルを作り直す（既存ぶんは破棄して採番しなおす） */
export function regeneratePackages(handoverId, count) {
  db.prepare('DELETE FROM packages WHERE handover_id = ?').run(handoverId);
  const insert = db.prepare(
    'INSERT INTO packages (handover_id, seq, token, created_at) VALUES (?, ?, ?, ?) RETURNING *'
  );
  const at = nowIso();
  const rows = [];
  for (let seq = 1; seq <= count; seq++) rows.push(insert.get(handoverId, seq, newUniqueToken(), at));
  return rows;
}

export const listPackages = (handoverId) =>
  db.prepare('SELECT * FROM packages WHERE handover_id = ? ORDER BY seq').all(handoverId);

export const getPackageByToken = (token) =>
  db.prepare('SELECT * FROM packages WHERE token = ?').get(token) ?? null;

export function createHandover(input, actor) {
  // token は UNIQUE。極めて低確率だが衝突したら引き直す。
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = newUniqueToken();
    const at = nowIso();
    try {
      const row = db
        .prepare(
          `INSERT INTO handovers (
             token, status, customer_name, customer_kana, company, phone, email,
             order_no, item_desc, item_count, storage_location,
             pickup_from, pickup_until, note, issued_by, created_at, updated_at
           ) VALUES (?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .get(
          token,
          input.customer_name,
          input.customer_kana ?? '',
          input.company ?? '',
          input.phone ?? '',
          input.email ?? '',
          input.order_no ?? '',
          input.item_desc ?? '',
          Number(input.item_count) || 1,
          input.storage_location ?? '',
          input.pickup_from ?? '',
          input.pickup_until ?? '',
          input.note ?? '',
          actor,
          at,
          at
        );

      regeneratePackages(row.id, row.item_count);
      addEvent({ handover_id: row.id, type: 'issued', actor, record_hash: recordHash(row) });
      return row;
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('引渡番号の発行に失敗しました');
}

export function updateHandover(id, input, actor) {
  const at = nowIso();
  const before = getHandover(id);
  const row = db
    .prepare(
      `UPDATE handovers SET
         customer_name = ?, customer_kana = ?, company = ?, phone = ?, email = ?,
         order_no = ?, item_desc = ?, item_count = ?, storage_location = ?,
         pickup_from = ?, pickup_until = ?, note = ?, updated_at = ?
       WHERE id = ? AND status = 'issued'
       RETURNING *`
    )
    .get(
      input.customer_name,
      input.customer_kana ?? '',
      input.company ?? '',
      input.phone ?? '',
      input.email ?? '',
      input.order_no ?? '',
      input.item_desc ?? '',
      Number(input.item_count) || 1,
      input.storage_location ?? '',
      input.pickup_from ?? '',
      input.pickup_until ?? '',
      input.note ?? '',
      at,
      id
    );

  if (!row) return null;

  // 個数が変わったらラベルを刷り直す必要がある。
  // 番号が変わるので、貼り替えが要ることを履歴に残しておく。
  const relabelled = before && before.item_count !== row.item_count;
  if (relabelled) regeneratePackages(id, row.item_count);

  addEvent({
    handover_id: id,
    type: 'edited',
    actor,
    note: relabelled ? `個数を ${before.item_count} → ${row.item_count} に変更。荷物ラベルを再発行しました。` : '',
    record_hash: recordHash(row),
  });
  return row;
}

export const getHandover = (id) => db.prepare('SELECT * FROM handovers WHERE id = ?').get(id) ?? null;

export const getHandoverByToken = (token) =>
  db.prepare('SELECT * FROM handovers WHERE token = ?').get(token) ?? null;

export function listHandovers({ q = '', status = '', limit = 50, offset = 0 } = {}) {
  const where = [];
  const args = [];

  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (q) {
    const cols = [
      'customer_name',
      'customer_kana',
      'company',
      'phone',
      'order_no',
      'token',
      'item_desc',
    ];
    where.push(`(${cols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    for (const _ of cols) args.push(`%${q}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM handovers ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
}

export function countHandovers() {
  return db
    .prepare(
      `SELECT
         COUNT(*)                                   AS total,
         COALESCE(SUM(status = 'issued'), 0)        AS issued,
         COALESCE(SUM(status = 'completed'), 0)     AS completed,
         COALESCE(SUM(status = 'cancelled'), 0)     AS cancelled
       FROM handovers`
    )
    .get();
}

export function cancelHandover(id, actor, note = '') {
  const row = db
    .prepare(
      `UPDATE handovers SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND status = 'issued' RETURNING *`
    )
    .get(nowIso(), id);
  if (row) addEvent({ handover_id: id, type: 'cancelled', actor, note, record_hash: recordHash(row) });
  return row ?? null;
}

/**
 * サインを受け取って引渡しを確定する。
 * status を条件に入れているので、二重引渡し（同じQRの使い回し）はここで弾かれる。
 */
export function completeHandover(id, { actor, receiverName, receiverRelation, signaturePng, note, userAgent, packagesScanned = [] }) {
  const at = nowIso();
  const row = db
    .prepare(
      `UPDATE handovers SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'issued' RETURNING *`
    )
    .get(at, at, id);

  if (!row) return null;

  addEvent({
    handover_id: id,
    type: 'completed',
    at,
    actor,
    receiver_name: receiverName,
    receiver_relation: receiverRelation,
    signature_png: signaturePng,
    note,
    user_agent: userAgent,
    record_hash: recordHash(row),
    packages_scanned: JSON.stringify(packagesScanned),
  });
  return row;
}

export function addEvent({
  handover_id,
  type,
  at = nowIso(),
  actor = '',
  receiver_name = '',
  receiver_relation = '',
  signature_png = null,
  note = '',
  user_agent = '',
  record_hash = '',
  packages_scanned = '',
}) {
  return db
    .prepare(
      `INSERT INTO events (
         handover_id, type, at, actor, receiver_name, receiver_relation,
         signature_png, note, user_agent, record_hash, packages_scanned
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(handover_id, type, at, actor, receiver_name, receiver_relation,
         signature_png, note, user_agent, record_hash, packages_scanned);
}

/** 一覧表示用。サイン画像そのものは重いので、有無だけ返す。 */
export const listEvents = (handoverId) =>
  db
    .prepare(
      `SELECT id, type, at, actor, receiver_name, receiver_relation, note, user_agent,
              record_hash, packages_scanned, signature_png IS NOT NULL AS has_signature
         FROM events WHERE handover_id = ? ORDER BY id`
    )
    .all(handoverId);

export const getSignature = (eventId) =>
  db.prepare('SELECT signature_png FROM events WHERE id = ?').get(eventId)?.signature_png ?? null;

export const getLatestSignatureEvent = (handoverId) =>
  db
    .prepare(
      `SELECT id FROM events
        WHERE handover_id = ? AND signature_png IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get(handoverId) ?? null;
