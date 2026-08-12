import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(__dirname, '..');
export const PUBLIC_DIR = resolve(ROOT, 'public');
export const CERT_DIR = resolve(ROOT, 'certs');

export const HTTP_PORT = Number(process.env.PORT) || 8080;
export const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;

export const orgName = () => process.env.HANDOVER_ORG_NAME || '荷物引渡し窓口';

/** 時間外セルフ受取のQRに入れる、社外から届くURL */
export const publicUrl = () => (process.env.HANDOVER_PUBLIC_URL ?? '').replace(/\/+$/, '');

/** HTTPSの証明書が用意されているか（PowerShell製のPFXにも対応） */
export const hasCertificate = () =>
  existsSync(resolve(CERT_DIR, 'server.pfx')) ||
  (existsSync(resolve(CERT_DIR, 'server.key')) && existsSync(resolve(CERT_DIR, 'server.crt')));

/**
 * いま持っているIPアドレスが、証明書に入っているかを調べる。
 *
 * ネットワークが変わる（テザリングに切り替えた、DHCPでIPが変わった、
 * 別の島に移した）と、証明書に書いていないアドレスになる。
 * するとブラウザは証明書を拒否し、カメラも使えなくなる。
 * しかも「昨日まで動いていたのに」という形で出るので原因にたどり着きにくい。
 * 起動時と画面で知らせて、証明書を作り直せば直ることが分かるようにする。
 */
export function certificateCoverage() {
  const addrs = lanAddresses();
  const crt = resolve(CERT_DIR, 'server.crt');
  if (!existsSync(crt)) return { hasCert: false, missing: [], covered: addrs };

  try {
    const cert = new X509Certificate(readFileSync(crt));
    const missing = addrs.filter((ip) => !cert.checkIP(ip));
    return { hasCert: true, missing, covered: addrs.filter((ip) => !missing.includes(ip)) };
  } catch {
    // 証明書が壊れているなら、作り直せば直る。ここでは判定しない。
    return { hasCert: true, missing: [], covered: addrs };
  }
}

/** このPCが社内LANで持っているIPv4アドレス */
export function lanAddresses() {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address)
    ),
  ];
}

/**
 * 他の端末（スマホ・他のPC）から、このサーバを開くためのURL一覧。
 *
 * スマホのカメラはHTTPSでないと動かないので、証明書があるときは
 * HTTPS のURLだけを案内する。無いときは HTTP を案内しつつ、
 * カメラが使えないことを画面側で伝える。
 */
export function connectUrls() {
  const secure = hasCertificate();
  const ips = lanAddresses();
  const host = hostname();

  // 他のPCからは、IPよりコンピュータ名で開いてもらうほうがよい。
  // 社内DHCPでIPが変わってもブックマークが切れないため。
  // 証明書にもコンピュータ名を入れてあるので、HTTPSでも使える。
  const names = host && host !== 'localhost' ? [host] : [];

  return {
    secure,
    hostname: host,
    urls: ips.map((ip) => (secure ? `https://${ip}:${HTTPS_PORT}` : `http://${ip}:${HTTP_PORT}`)),
    // 証明書を使わずにカメラを許可する方法（Chromeの設定で例外にする）と、
    // カメラを使わない他のPC向けの案内に使う
    httpUrls: [...names, ...ips].map((h) => `http://${h}:${HTTP_PORT}`),
  };
}
