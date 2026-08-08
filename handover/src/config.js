import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
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
  const scheme = secure ? 'https' : 'http';
  const port = secure ? HTTPS_PORT : HTTP_PORT;
  return {
    secure,
    urls: lanAddresses().map((ip) => `${scheme}://${ip}:${port}`),
  };
}
