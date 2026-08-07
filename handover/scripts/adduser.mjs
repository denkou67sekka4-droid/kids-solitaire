/**
 * 担当者アカウントを追加する。
 *
 *   npm run adduser -- <ユーザー名> [表示名]
 *
 * 「誰が引き渡したか」が履歴に残るので、担当者ごとに分けて作るのがおすすめ。
 * パスワードは自動生成して1度だけ表示する。
 */
import { createUser, findUserByName, generatePassword } from '../src/db.js';

const [username, displayName] = process.argv.slice(2);

if (!username) {
  console.error('使い方: npm run adduser -- <ユーザー名> [表示名]');
  console.error('例    : npm run adduser -- tanaka 田中');
  process.exit(1);
}

if (findUserByName(username)) {
  console.error(`ユーザー「${username}」は既に存在します。`);
  process.exit(1);
}

const password = generatePassword();
createUser({ username, password, displayName: displayName || username });

console.log('');
console.log('アカウントを作成しました');
console.log(`  ユーザー名 : ${username}`);
console.log(`  表示名     : ${displayName || username}`);
console.log(`  パスワード : ${password}`);
console.log('');
console.log('※ パスワードの表示はこの1回だけです。控えてください。');
console.log('');
