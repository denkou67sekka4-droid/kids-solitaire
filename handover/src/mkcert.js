/**
 * HTTPS用の証明書を作る。
 *
 * なぜ自前で書いたか:
 *   OpenSSL は Windows に入っていない。PowerShell の New-SelfSignedCertificate は
 *   使えるが、実行ポリシーや文字コードで詰まりやすく、環境によっては動かない。
 *   証明書が作れないとスマホのカメラが使えず、このアプリは用をなさないので、
 *   いちばん確実な「Node だけで完結する」方法にした。
 *   Windows / macOS / Linux で同じコードが動き、追加のインストールも要らない。
 *
 * 作るもの:
 *   ca      … 社内用の認証局（CA:TRUE）。スマホに入れる
 *   server  … ca が署名したサーバ証明書（CA:FALSE + subjectAltName）
 *
 * 1枚では足りない理由:
 *   Android が「CA証明書」として受け入れるには CA:TRUE が要り、
 *   サーバ証明書は CA:FALSE でなければならない。両立しないので分ける。
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * ASN.1 DER の組み立て
 *
 * 証明書は DER というバイト列の形式で表される。
 * 「タグ1バイト + 長さ + 中身」の入れ子で、規則自体は単純。
 * ------------------------------------------------------------------ */

const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  PRINTABLE: 0x13,
  IA5: 0x16,
  UTC_TIME: 0x17,
};

/** 長さの表現。127以下はそのまま、それ以上は「バイト数 | 0x80」＋長さ本体 */
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), len(value.length), value]);

const seq = (...parts) => tlv(TAG.SEQUENCE, Buffer.concat(parts));
const set = (...parts) => tlv(TAG.SET, Buffer.concat(parts));

/** 文脈依存タグ。構造を持つものは 0xA0 系、単純な値は 0x80 系 */
const ctx = (n, value, constructed = true) =>
  tlv((constructed ? 0xa0 : 0x80) | n, value);

function int(value) {
  let buf = typeof value === 'number' ? Buffer.from([value]) : Buffer.from(value);
  // 先頭ビットが立っていると負の数と解釈されるので 0x00 を足す
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(TAG.INTEGER, buf);
}

/** "1.2.840.113549.1.1.11" のような文字列を DER の OID に変換する */
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [];
    let v = p;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/** BIT STRING は先頭に「末尾の未使用ビット数」が入る */
const bitString = (buf, unused = 0) => tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([unused]), buf]));

const octetString = (buf) => tlv(TAG.OCTET_STRING, buf);
const nullValue = () => Buffer.from([TAG.NULL, 0x00]);
const boolean = (v) => tlv(TAG.BOOLEAN, Buffer.from([v ? 0xff : 0x00]));

/** UTCTime は YYMMDDHHMMSSZ（2049年まで有効な表現） */
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  return tlv(TAG.UTC_TIME, Buffer.from(s, 'ascii'));
}

/* ------------------------------------------------------------------ *
 * 証明書の部品
 * ------------------------------------------------------------------ */

const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const signatureAlgorithm = () => seq(oid(OID.sha256WithRSA), nullValue());

/** CN と O だけの Name。日本語を入れるので UTF8String を使う */
function name({ cn, o }) {
  const rdn = (attrOid, value) => set(seq(oid(attrOid), tlv(TAG.UTF8, Buffer.from(value, 'utf8'))));
  const parts = [rdn(OID.commonName, cn)];
  if (o) parts.push(rdn(OID.organizationName, o));
  return seq(...parts);
}

const extension = (extOid, critical, value) =>
  seq(oid(extOid), ...(critical ? [boolean(true)] : []), octetString(value));

/**
 * subjectAltName。
 * IPアドレスで接続する場合、ブラウザは dNSName ではなく iPAddress の項目しか見ない。
 * ここを間違えると「証明書は作れたのに拒否される」になる。
 */
function subjectAltName(sans) {
  const parts = sans.map((san) => {
    if (san.type === 'dns') return tlv(0x82, Buffer.from(san.value, 'ascii')); // dNSName [2]
    if (san.type === 'ip') return tlv(0x87, Buffer.from(san.value.split('.').map(Number))); // iPAddress [7]
    throw new Error(`未知のSANの種類: ${san.type}`);
  });
  return seq(...parts);
}

/** 公開鍵のSHA-1。証明書どうしの親子関係をたどるための目印 */
function keyIdentifier(spkiDer) {
  // SPKI の中の BIT STRING（公開鍵そのもの）を取り出してハッシュする
  const bitStringStart = spkiDer.indexOf(0x03, spkiDer.indexOf(0x30, 2));
  let i = bitStringStart + 1;
  let length = spkiDer[i];
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let k = 0; k < n; k++) length = length * 256 + spkiDer[i + 1 + k];
    i += n;
  }
  const keyBits = spkiDer.subarray(i + 2, i + 1 + length); // 先頭の未使用ビット数を飛ばす
  return createHash('sha1').update(keyBits).digest();
}

/**
 * 証明書を1枚作る。
 * issuer を省略すると自己署名（＝認証局そのもの）になる。
 */
function makeCertificate({ subject, issuer, publicKey, signingKey, days, isCa, sans }) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const notBefore = new Date(Date.now() - 24 * 3600_000); // 時計のずれに備えて1日前から
  const notAfter = new Date(Date.now() + days * 24 * 3600_000);

  const extensions = [];

  extensions.push(
    extension(OID.basicConstraints, true, isCa ? seq(boolean(true), int(0)) : seq())
  );

  extensions.push(
    isCa
      // 認証局は「証明書に署名する」ためのもの
      ? extension(OID.keyUsage, true, bitString(Buffer.from([0b00000110]), 1))
      // サーバは鍵交換と署名に使う
      : extension(OID.keyUsage, true, bitString(Buffer.from([0b10100000]), 5))
  );

  if (!isCa) {
    extensions.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
    extensions.push(extension(OID.subjectAltName, false, subjectAltName(sans)));
  }

  const subjectKeyId = keyIdentifier(spki);
  extensions.push(extension(OID.subjectKeyId, false, octetString(subjectKeyId)));

  const issuerKeyId = issuer ? issuer.subjectKeyId : subjectKeyId;
  extensions.push(extension(OID.authorityKeyId, false, seq(ctx(0, issuerKeyId, false))));

  const tbs = seq(
    ctx(0, int(2)),                       // version: v3
    int(randomBytes(16)),                 // serialNumber
    signatureAlgorithm(),
    issuer ? issuer.subjectDer : name(subject),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(subject),
    spki,
    ctx(3, seq(...extensions))            // extensions
  );

  const signature = createSign('sha256').update(tbs).sign(signingKey);
  const der = seq(tbs, signatureAlgorithm(), bitString(signature));

  return { der, subjectKeyId, subjectDer: name(subject) };
}

const toPem = (der, label) =>
  `-----BEGIN ${label}-----\n` +
  (der.toString('base64').match(/.{1,64}/g) ?? []).join('\n') +
  `\n-----END ${label}-----\n`;

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 認証局とサーバ証明書を作る。
 * sans は [{ type: 'dns'|'ip', value }] の配列。
 */
export function createCertificates({ sans, orgName = 'Handover QR', caDays = 3650, serverDays = 825 }) {
  if (!sans.length) throw new Error('証明書に入れるアドレスが1つもありません');

  const caKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serverKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const ca = makeCertificate({
    subject: { cn: `${orgName} 社内CA`, o: orgName },
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    days: caDays,
    isCa: true,
  });

  const server = makeCertificate({
    subject: { cn: orgName, o: orgName },
    issuer: ca,
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,   // 認証局の鍵で署名する
    days: serverDays,
    isCa: false,
    sans,
  });

  const caPem = toPem(ca.der, 'CERTIFICATE');

  return {
    caPem,
    caKeyPem: caKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    // ブラウザに認証局まで届くよう、サーバが返す証明書は2枚つなげておく
    serverPem: toPem(server.der, 'CERTIFICATE') + caPem,
    serverKeyPem: serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
