import { deflateSync } from 'node:zlib';
import qrcodeGenerator from 'qrcode-generator';

/**
 * QRコードの生成。
 *
 * 誤り訂正レベルは 'Q'（約25%まで復元可能）で固定している。
 * 引渡番号は14文字の英数字なので、レベルQでもバージョン1（21x21マス）に収まる。
 * つまり「訂正能力を上げつつ、1マスを最大限大きく保てる」いちばん美味しい組み合わせ。
 * これがFAXを通すための肝で、ここに顧客名や住所を足した瞬間にバージョンが上がって
 * マスが細かくなり、FAX送信で潰れて読めなくなる。
 */
const EC_LEVEL = 'Q';
const QUIET_ZONE = 4; // JIS/ISO が要求する最小の余白（マス数）。削るとスキャン率が落ちる。

function build(text) {
  // typeNumber 0 = 収まる最小バージョンを自動選択
  const qr = qrcodeGenerator(0, EC_LEVEL);
  // 英数字モードはバイトモードより高密度に詰められる（= バージョンを低く保てる）
  qr.addData(text, 'Alphanumeric');
  qr.make();
  return qr;
}

/** QRを true/false の二次元配列（余白込み）にする */
export function toMatrix(text) {
  const qr = build(text);
  const n = qr.getModuleCount();
  const size = n + QUIET_ZONE * 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = new Array(size).fill(false);
    for (let x = 0; x < size; x++) {
      const my = y - QUIET_ZONE;
      const mx = x - QUIET_ZONE;
      if (my >= 0 && my < n && mx >= 0 && mx < n) row[x] = qr.isDark(my, mx);
    }
    rows.push(row);
  }
  return { rows, size, version: (n - 17) / 4 };
}

/**
 * 印刷用のSVG。
 * 黒マスを1本のパスにまとめている。プリンタドライバによっては
 * 矩形を大量に並べると隣接マスの間に白い筋が出ることがあるため。
 */
export function toSvg(text, { sizeMm = 55 } = {}) {
  const { rows, size } = toMatrix(text);
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rows[y][x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeMm}mm" height="${sizeMm}mm" ` +
    `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="引渡番号 ${text} のQRコード">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * 最小限のPNGエンコーダ
 * メール添付用にPNGが要る。QRは白黒2値なので、
 * 外部ライブラリを足さずにグレースケール8bitで書き出す。
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 目標ピクセル数に近づくよう、1マスあたりの整数倍率を選ぶ（非整数だとマスが歪む） */
export function toPng(text, { targetPx = 900 } = {}) {
  const { rows, size } = toMatrix(text);
  const scale = Math.max(1, Math.round(targetPx / size));
  const dim = size * scale;

  // 各行の先頭にフィルタバイト(0 = None)が要る
  const raw = Buffer.alloc((dim + 1) * dim);
  let p = 0;
  for (let y = 0; y < dim; y++) {
    raw[p++] = 0;
    const srcRow = rows[(y / scale) | 0];
    for (let x = 0; x < dim; x++) {
      raw[p++] = srcRow[(x / scale) | 0] ? 0x00 : 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: グレースケール
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 印刷時に実寸が出るよう解像度を埋めておく（300dpi 相当）
  const phys = Buffer.alloc(9);
  const ppm = Math.round(300 / 0.0254);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1; // 単位: メートル

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
