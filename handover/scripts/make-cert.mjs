/**
 * スマホのカメラを使うための証明書を作る。
 *
 *   Windows      : make-cert.bat をダブルクリック
 *   macOS/Linux  : npm run cert
 *
 * ブラウザは localhost を除き、HTTPSでないとカメラを許可しない。
 * 社内LANの http://192.168.x.x では getUserMedia が必ず失敗するため、
 * このアプリを使うには証明書が要る。
 *
 * OpenSSL も PowerShell も使わない。Node だけで完結する。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { createCertificates } from '../src/mkcert.js';
import { CERT_DIR, orgName } from '../src/config.js';

/* 証明書に入れるアドレスを集める。
   ここに含まれないアドレスでアクセスすると、ブラウザは証明書を拒否する。 */
const sans = [
  { type: 'dns', value: 'localhost' },
  { type: 'ip', value: '127.0.0.1' },
];

const host = hostname();
if (host && host !== 'localhost') {
  // 社内DHCPでIPが変わっても http://PC名:8080 で開けるようにしておく
  sans.push({ type: 'dns', value: host });
  sans.push({ type: 'dns', value: `${host}.local` });
}

for (const net of Object.values(networkInterfaces()).flat()) {
  if (net && net.family === 'IPv4' && !net.internal) {
    sans.push({ type: 'ip', value: net.address });
  }
}

// 追加したいアドレスがあるとき: EXTRA_SAN="handover.local,10.0.0.5" npm run cert
for (const extra of (process.env.EXTRA_SAN ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  sans.push({ type: /^\d+\.\d+\.\d+\.\d+$/.test(extra) ? 'ip' : 'dns', value: extra });
}

// 同じ値が二度入らないようにする
const unique = [...new Map(sans.map((s) => [`${s.type}:${s.value}`, s])).values()];

console.log('');
console.log('  証明書に含めるアドレス:');
for (const s of unique) console.log(`    ${s.type === 'ip' ? 'IP  ' : 'DNS '} ${s.value}`);

const hasIp = unique.some((s) => s.type === 'ip' && s.value !== '127.0.0.1');
if (!hasIp) {
  console.log('');
  console.log('  [!] このPCの社内LANアドレスが見つかりませんでした。');
  console.log('      有線LANまたはWi-Fiにつないでから、もう一度実行してください。');
  console.log('      （つながっていないと、スマホからアクセスできません）');
}

/* 作り直すと、スマホに入れた証明書が使えなくなるので確認する */
const caPath = resolve(CERT_DIR, 'ca.crt');
if (existsSync(caPath) && process.stdin.isTTY && !process.argv.includes('--force')) {
  console.log('');
  console.log('  すでに証明書があります。');
  console.log('  作り直すと、スマホに入れた証明書を入れ直す必要があります。');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('  作り直しますか？ (y/N): ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('  そのままにしました。');
    process.exit(0);
  }
}

console.log('');
console.log('  作成しています（10秒ほどかかります）...');

const { caPem, caKeyPem, serverPem, serverKeyPem } = createCertificates({
  sans: unique,
  orgName: orgName(),
});

mkdirSync(CERT_DIR, { recursive: true });

// PowerShell版が作った server.pfx が残っていると、そちらが優先されてしまう
const pfx = resolve(CERT_DIR, 'server.pfx');
if (existsSync(pfx)) {
  writeFileSync(resolve(CERT_DIR, 'server.pfx.old'), readFileSync(pfx));
  writeFileSync(pfx, '');
}

writeFileSync(resolve(CERT_DIR, 'ca.crt'), caPem);
writeFileSync(resolve(CERT_DIR, 'ca.key'), caKeyPem, { mode: 0o600 });
writeFileSync(resolve(CERT_DIR, 'server.crt'), serverPem);
writeFileSync(resolve(CERT_DIR, 'server.key'), serverKeyPem, { mode: 0o600 });

console.log('');
console.log('  証明書を作成しました:');
console.log(`    ${resolve(CERT_DIR, 'server.crt')}   サーバ用（自動で読み込まれます）`);
console.log(`    ${resolve(CERT_DIR, 'ca.crt')}       スマホに入れる用`);
console.log('');
console.log('  次にやること:');
console.log('    1) start.bat（またはサーバ）を起動しなおす');
console.log('    2) 黒い画面に出る  https://<このPCのIP>:8443  をスマホで開く');
console.log('       ※ 事務PCの［スマホをつなぐ］にQRが出ます');
console.log('    3) 警告が出たら［詳細設定］→［...にアクセスする］で進む');
console.log('');
console.log('  ※ certs フォルダには秘密鍵が入っています。');
console.log('     共有フォルダに置かないでください。配ってよいのは ca.crt だけです。');
console.log('');
