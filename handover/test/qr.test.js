import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

import { toMatrix, toPng, toSvg } from '../src/qr.js';
import { generateToken } from '../src/token.js';

const jsQR = createRequire(import.meta.url)('jsqr').default ?? createRequire(import.meta.url)('jsqr');

/** 生成したPNGを読み直して RGBA にする（グレースケール8bit・フィルタ0前提） */
function decodePng(buf) {
  let pos = 8; // シグネチャを飛ばす
  let width = 0;
  let height = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'ビット深度は8のはず');
      assert.equal(data[9], 0, 'カラータイプはグレースケールのはず');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // 長さ + 種別 + データ + CRC
  }

  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    assert.equal(raw[rowStart], 0, 'フィルタは None のはず');
    for (let x = 0; x < width; x++) {
      const v = raw[rowStart + 1 + x];
      const o = (y * width + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  return { data: rgba, width, height };
}

test('引渡番号のQRは必ずバージョン1（21x21マス）に収まる', () => {
  // ここが崩れるとFAXで読めなくなる。QRに情報を足そうとしたらこのテストが落ちる。
  for (let i = 0; i < 200; i++) {
    const { version } = toMatrix(generateToken());
    assert.equal(version, 1, 'QRのバージョンが上がっている＝FAXで潰れる危険');
  }
});

test('余白（クワイエットゾーン）が4マス確保されている', () => {
  const { rows, size } = toMatrix(generateToken());
  assert.equal(size, 21 + 8);
  for (let i = 0; i < 4; i++) {
    assert.ok(rows[i].every((v) => v === false), '上の余白に黒がある');
    assert.ok(rows[size - 1 - i].every((v) => v === false), '下の余白に黒がある');
    assert.ok(rows.every((r) => r[i] === false), '左の余白に黒がある');
    assert.ok(rows.every((r) => r[size - 1 - i] === false), '右の余白に黒がある');
  }
});

test('生成したPNGを読み取ると元の引渡番号に戻る', () => {
  for (let i = 0; i < 30; i++) {
    const token = generateToken();
    const png = toPng(token, { targetPx: 600 });
    const img = decodePng(png);
    const decoded = jsQR(img.data, img.width, img.height);

    assert.ok(decoded, `${token} のQRを読み取れなかった`);
    assert.equal(decoded.data, token);
  }
});

test('PNGは白黒2値だけで構成されている（FAXで中間調が出ない）', () => {
  const img = decodePng(toPng(generateToken(), { targetPx: 400 }));
  const values = new Set();
  for (let i = 0; i < img.data.length; i += 4) values.add(img.data[i]);
  assert.deepEqual([...values].sort((a, b) => a - b), [0, 255]);
});

test('SVGは実寸指定で出力され、モジュールの縁がぼけない', () => {
  const svg = toSvg(generateToken(), { sizeMm: 55 });
  assert.match(svg, /width="55mm"/);
  assert.match(svg, /height="55mm"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /viewBox="0 0 29 29"/);
  // 印刷時に地色が抜けないよう、白の下地を必ず敷く
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/);
});

test('55mm・バージョン1なら1マスが約1.9mmになる（FAXの解像度に対して十分）', () => {
  const { size } = toMatrix(generateToken());
  const moduleMm = 55 / size;
  assert.ok(moduleMm > 1.8, `1マス ${moduleMm.toFixed(2)}mm は小さすぎる`);

  // FAXのファインモード(203x196dpi)で1マスが何ドットになるか
  const dotsPerModule = (moduleMm / 25.4) * 196;
  assert.ok(dotsPerModule > 10, `1マス ${dotsPerModule.toFixed(1)}ドットでは潰れる`);
});
