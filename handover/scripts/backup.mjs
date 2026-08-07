/**
 * データベースのバックアップを取る。
 *
 *   npm run backup [-- 保存先フォルダ]
 *
 * 稼働中にファイルをそのままコピーすると、書き込み途中の状態を掴んで
 * 開けない控えができることがある（SQLiteは変更をWALに溜めるため）。
 * VACUUM INTO を使うと、動かしたままでも整合の取れた1ファイルを書き出せる。
 *
 * 24時間動かす運用なら、タスクスケジューラで1日1回動かしておくとよい。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const KEEP = Number(process.env.HANDOVER_BACKUP_KEEP) || 30; // 世代数

const dbPath = resolve(process.env.HANDOVER_DB ?? 'data/handover.db');
const outDir = resolve(process.argv[2] ?? process.env.HANDOVER_BACKUP_DIR ?? 'data/backup');

mkdirSync(outDir, { recursive: true });

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
const outPath = join(outDir, `handover-${stamp}.db`);

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // VACUUM INTO はプレースホルダを受け付けないので、パスは引用符を escape して埋め込む
  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const size = statSync(outPath).size;
console.log(`バックアップを作成しました: ${outPath} (${(size / 1024).toFixed(0)} KB)`);

// 古い世代を捨てる
const olds = readdirSync(outDir)
  .filter((f) => /^handover-\d{8}-\d{4}\.db$/.test(f))
  .sort()
  .slice(0, -KEEP);

for (const f of olds) {
  unlinkSync(join(outDir, f));
  console.log(`古いバックアップを削除: ${f}`);
}

console.log(`保存世代数: ${KEEP}（環境変数 HANDOVER_BACKUP_KEEP で変更できます）`);
