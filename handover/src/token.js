import { randomInt } from 'node:crypto';

/**
 * 引渡番号（トークン）の生成と検証。
 *
 * 設計上のいちばん重要な制約は「FAXを通ること」。
 * FAXは標準モードで 203x98dpi しかなく、情報量の多いQR（バージョンが大きいQR）は
 * 送信・受信の過程で潰れて読めなくなる。
 * そこでQRには顧客情報そのものを入れず、この短いトークンだけを入れる。
 * 14文字（区切りのハイフン込み）の英数字なら QR バージョン1（21x21マス）に収まり、
 * 60mm四方で印刷すれば1マスが約2.9mm。FAXでも余裕で読み取れる。
 *
 * 文字集合から I / L / O / U / 0 / 1 を除いてあるのは、
 * FAXが潰れて手入力に切り替わったときの読み違いを防ぐため。
 * （QRの英数字モードで使える文字だけで構成している）
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP = 4;
const GROUPS = 3;
const BODY_LEN = GROUP * GROUPS - 1; // 末尾1文字はチェックディジット
const TOKEN_RE = /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/;

/** 手入力ミスを弾くためのチェックディジット（mod 30） */
function checkDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const v = ALPHABET.indexOf(body[i]);
    // 位置によって重みを変えて、隣接文字の入れ替わりも検出できるようにする
    sum += v * (i % 2 === 0 ? 3 : 1);
  }
  return ALPHABET[sum % ALPHABET.length];
}

/** `XXXX-XXXX-XXXX` 形式の引渡番号を新規発行する */
export function generateToken() {
  let body = '';
  for (let i = 0; i < BODY_LEN; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return format(body + checkDigit(body));
}

/** ハイフンを4文字ごとに入れる */
export function format(raw) {
  return raw.match(/.{1,4}/g).join('-');
}

/**
 * 入力された文字列を正規の引渡番号に正規化する。
 * 手入力・QR・URL埋め込みのどれでも受け取れるようにしてある。
 * 正規化できなければ null。
 */
export function normalizeToken(input) {
  if (typeof input !== 'string') return null;

  let s = input.trim();

  // QRにURLが入っていた場合（他社製のQRを混ぜて運用する可能性を考慮）
  const urlMatch = s.match(/[?&/](?:t|token|code)=?([0-9A-Za-z-]{12,20})/);
  if (urlMatch) s = urlMatch[1];

  // 全角で入力されることが多いので半角に寄せる
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.toUpperCase().replace(/[^0-9A-Z]/g, '');

  // I/L/O/U/0/1 はそもそも採用していない。
  // 似た文字への「補正」は別の有効なトークンに化けさせてしまうので、あえて何もせず弾く。
  if (s.length !== GROUP * GROUPS) return null;
  if (![...s].every((c) => ALPHABET.includes(c))) return null;

  const body = s.slice(0, BODY_LEN);
  if (s[BODY_LEN] !== checkDigit(body)) return null;

  return format(s);
}

/** 表示・保存用に、すでに正しい形式かどうかだけを見る */
export function isValidToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const raw = token.replace(/-/g, '');
  return raw[BODY_LEN] === checkDigit(raw.slice(0, BODY_LEN));
}
