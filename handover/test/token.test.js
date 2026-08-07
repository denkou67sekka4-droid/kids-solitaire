import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, isValidToken, normalizeToken } from '../src/token.js';

test('発行したトークンは常に XXXX-XXXX-XXXX 形式で、検証を通る', () => {
  for (let i = 0; i < 500; i++) {
    const t = generateToken();
    assert.match(t, /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
    assert.ok(isValidToken(t), `${t} が検証を通らない`);
  }
});

test('紛らわしい文字（I L O U 0 1）は使わない', () => {
  const banned = /[ILOU01]/;
  for (let i = 0; i < 500; i++) {
    assert.ok(!banned.test(generateToken()), '除外したはずの文字が出た');
  }
});

test('連続発行しても重複しない', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(generateToken());
  assert.equal(seen.size, 5000);
});

test('手入力のゆらぎを吸収する（小文字・全角・空白・ハイフン無し）', () => {
  const t = generateToken();
  const raw = t.replace(/-/g, '');
  const zenkaku = raw.replace(/[A-Z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

  assert.equal(normalizeToken(t), t);
  assert.equal(normalizeToken(t.toLowerCase()), t);
  assert.equal(normalizeToken(raw), t);
  assert.equal(normalizeToken(`  ${t}  `), t);
  assert.equal(normalizeToken(t.replace(/-/g, ' ')), t);
  assert.equal(normalizeToken(zenkaku), t);
});

test('QRにURLが入っていてもトークンを取り出せる', () => {
  const t = generateToken();
  assert.equal(normalizeToken(`https://example.com/scan?token=${t}`), t);
  assert.equal(normalizeToken(`https://example.com/s?t=${t}`), t);
});

test('1文字間違えるとチェックディジットで弾かれる', () => {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  let caught = 0;
  let tried = 0;

  for (let i = 0; i < 200; i++) {
    const t = generateToken();
    const raw = t.replace(/-/g, '');
    // 1文字だけ別の文字に置き換える
    const pos = i % raw.length;
    const replacement = alphabet[(alphabet.indexOf(raw[pos]) + 1 + (i % 7)) % alphabet.length];
    if (replacement === raw[pos]) continue;

    tried++;
    const broken = raw.slice(0, pos) + replacement + raw.slice(pos + 1);
    if (normalizeToken(broken) === null) caught++;
  }

  // mod 30 のチェックディジットなので、1文字違いは理論上すべて検出できる
  assert.equal(caught, tried, `${tried - caught} 件が検出漏れ`);
});

test('隣り合う2文字の入れ替わりを検出できる', () => {
  let caught = 0;
  let tried = 0;

  for (let i = 0; i < 300; i++) {
    const raw = generateToken().replace(/-/g, '');
    const pos = i % (raw.length - 1);
    if (raw[pos] === raw[pos + 1]) continue;

    tried++;
    const swapped = raw.slice(0, pos) + raw[pos + 1] + raw[pos] + raw.slice(pos + 2);
    if (normalizeToken(swapped) === null) caught++;
  }

  // 位置で重みを変えているので、入れ替わりも高い割合で捕まえられる
  assert.ok(caught / tried > 0.9, `検出率が低い: ${caught}/${tried}`);
});

test('形式が違う入力は null を返す', () => {
  for (const bad of ['', '   ', 'ABC', null, undefined, 42, {}, 'AAAA-AAAA-AAAA-AAAA', 'IIII-LLLL-OOOO']) {
    assert.equal(normalizeToken(bad), null, `${String(bad)} が通ってしまった`);
  }
});
