import { createServer } from 'node:net';

/**
 * 空いているポート番号を1つ取る。
 *
 * テストは複数ファイルが並行して走るため、乱数でポートを決めると
 * ときどき衝突して「サーバが起動しませんでした」で落ちる。
 * OSに空きを選ばせてから、そのポートでアプリを起動する。
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
