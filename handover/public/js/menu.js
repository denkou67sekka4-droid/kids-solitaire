import { api, esc, mountAppBar } from './app.js';

await mountAppBar({ title: '荷物引渡し管理' });

try {
  const { summary } = await api('/api/handovers?limit=1');
  const el = document.getElementById('summary');
  el.innerHTML =
    `<strong>現在の状況</strong>` +
    `未引渡 <b>${esc(summary.issued)}</b> 件 ／ ` +
    `引渡済 ${esc(summary.completed)} 件 ／ ` +
    `取消 ${esc(summary.cancelled)} 件`;
  el.hidden = false;
} catch {
  // 件数はあくまで補助情報。取れなくてもメニューは使えるので黙って諦める。
}
