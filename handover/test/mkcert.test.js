/**
 * 証明書の生成。
 *
 * スマホのカメラはHTTPSでしか動かないので、ここが壊れるとアプリが用をなさない。
 * しかも壊れ方が分かりにくい（「証明書は作れたのにブラウザが拒否する」）ので、
 * 中身の細かいところまで検査しておく。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPublicKey, createPrivateKey } from 'node:crypto';

import { createCertificates } from '../src/mkcert.js';

const SANS = [
  { type: 'dns', value: 'localhost' },
  { type: 'ip', value: '127.0.0.1' },
  { type: 'dns', value: 'JIMU-PC' },
  { type: 'ip', value: '192.168.1.23' },
];

const make = () => createCertificates({ sans: SANS, orgName: 'テスト運輸' });

test('認証局とサーバ、2枚の証明書が作られる', () => {
  const { caPem, serverPem, caKeyPem, serverKeyPem } = make();

  assert.match(caPem, /^-----BEGIN CERTIFICATE-----/);
  assert.match(caKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(serverKeyPem, /^-----BEGIN PRIVATE KEY-----/);

  // サーバ側は「サーバ証明書 + 認証局」の2枚つなぎ（ブラウザに連鎖を届けるため）
  assert.equal((serverPem.match(/BEGIN CERTIFICATE/g) ?? []).length, 2);
});

test('認証局は CA:TRUE、サーバ証明書は CA:FALSE', () => {
  const { caPem, serverPem } = make();

  // ここが逆だと、Androidが「CA証明書」として受け付けてくれない
  assert.equal(new X509Certificate(caPem).ca, true, '認証局が CA:TRUE になっていない');
  assert.equal(new X509Certificate(serverPem).ca, false, 'サーバ証明書が CA:FALSE になっていない');
});

test('サーバ証明書は認証局の鍵で署名されている', () => {
  const { caPem, serverPem, caKeyPem } = make();
  const ca = new X509Certificate(caPem);
  const server = new X509Certificate(serverPem);

  assert.ok(server.verify(ca.publicKey), '認証局で検証できない');
  assert.ok(ca.verify(ca.publicKey), '認証局が自己署名になっていない');
  assert.equal(server.issuer, ca.subject, '発行者が認証局になっていない');

  // 認証局の秘密鍵と公開鍵が対になっていること
  const derived = createPublicKey(createPrivateKey(caKeyPem)).export({ type: 'spki', format: 'pem' });
  assert.equal(derived, ca.publicKey.export({ type: 'spki', format: 'pem' }));
});

test('指定したホスト名・IPアドレスで検証が通る', () => {
  const server = new X509Certificate(make().serverPem);

  assert.ok(server.checkHost('localhost'), 'localhost が通らない');
  assert.ok(server.checkHost('JIMU-PC'), 'コンピュータ名が通らない');
  assert.ok(server.checkIP('127.0.0.1'), '127.0.0.1 が通らない');
  // ここが最重要。ブラウザはIP接続時に iPAddress の項目しか見ないため、
  // dNSName に書いてあっても拒否される
  assert.ok(server.checkIP('192.168.1.23'), '社内LANのIPが通らない');
});

test('指定していないアドレスは拒否される', () => {
  const server = new X509Certificate(make().serverPem);

  assert.ok(!server.checkHost('evil.example.com'));
  assert.ok(!server.checkIP('10.0.0.1'));
  assert.ok(!server.checkIP('192.168.1.24'));
});

test('サーバ証明書に serverAuth が入っている', () => {
  const server = new X509Certificate(make().serverPem);
  // 用途の指定が無い／違うと、ブラウザによっては拒否される
  assert.match(server.keyUsage?.join(',') ?? '', /1\.3\.6\.1\.5\.5\.7\.3\.1/);
});

test('会社名が証明書に入る（スマホの一覧で判別できるように）', () => {
  const { caPem } = createCertificates({ sans: SANS, orgName: '○○運輸株式会社' });
  const ca = new X509Certificate(caPem);
  assert.match(ca.subject, /○○運輸株式会社/, '日本語が壊れている');
  assert.match(ca.subject, /社内CA/);
});

test('有効期限が妥当で、時計が少しずれていても使える', () => {
  const server = new X509Certificate(make().serverPem);
  const from = new Date(server.validFrom);
  const to = new Date(server.validTo);

  assert.ok(from < new Date(), '開始日が未来になっている');
  assert.ok(to > new Date(Date.now() + 365 * 24 * 3600_000), '1年以内に切れてしまう');
  // PCの時計が数時間ずれていても使えるように、少し前から有効にしている
  assert.ok(from < new Date(Date.now() - 3600_000), '時計のずれに耐えられない');
});

test('毎回ちがう鍵と通し番号で作られる', () => {
  const a = new X509Certificate(make().serverPem);
  const b = new X509Certificate(make().serverPem);

  assert.notEqual(a.serialNumber, b.serialNumber, '通し番号が同じ');
  assert.notEqual(a.publicKey.export({ type: 'spki', format: 'pem' }),
                  b.publicKey.export({ type: 'spki', format: 'pem' }), '鍵が使い回されている');
});

test('アドレスが1つも無ければエラーにする', () => {
  assert.throws(() => createCertificates({ sans: [] }), /アドレスが1つもありません/);
});
