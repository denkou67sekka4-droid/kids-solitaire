import { api, esc, fmtDate, mountAppBar } from './app.js';

const id = new URLSearchParams(location.search).get('id');
const box = document.getElementById('labels');

await mountAppBar({ title: '荷物ラベル', back: id ? `/detail?id=${encodeURIComponent(id)}` : '/list' });

if (!id) {
  box.innerHTML = '<p class="empty">引渡票が指定されていません。</p>';
  throw new Error('id が指定されていません');
}

document.getElementById('printBtn').addEventListener('click', () => window.print());
document.getElementById('sheetLink').href = `/sheet?id=${encodeURIComponent(id)}`;
document.getElementById('detailLink').href = `/detail?id=${encodeURIComponent(id)}`;

const { handover: h, packages } = await api(`/api/handovers/${encodeURIComponent(id)}`);
const { org } = await api('/api/config');

if (!packages.length) {
  box.innerHTML = '<p class="empty">この引渡票には荷物ラベルがありません。</p>';
} else {
  const field = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : '');

  box.innerHTML = packages
    .map(
      (p) => `
      <section class="label">
        <div class="label-head">
          <span class="title">荷 物 ラ ベ ル</span>
          <span class="seq">${p.seq} / ${packages.length}</span>
        </div>

        <div class="label-body">
          <dl>
            <dt>お客様</dt><dd class="name">${esc(h.customer_name)} 様</dd>
            ${field('会社名', h.company)}
            ${field('受注番号', h.order_no)}
            ${field('品名', h.item_desc)}
            ${field('保管場所', h.storage_location)}
            ${field('引取期限', h.pickup_until ? fmtDate(h.pickup_until) : '')}
            ${field('発行', org)}
          </dl>
        </div>

        <div class="label-qr">
          <div class="caption">照 合 用</div>
          <img src="/qr/${encodeURIComponent(p.token)}.svg?mm=40"
               alt="荷物ラベル ${p.seq}/${packages.length} のQRコード" width="151" height="151">
          <div class="token">${esc(p.token)}</div>
        </div>
      </section>`
    )
    .join('');
}
box.setAttribute('aria-busy', 'false');
