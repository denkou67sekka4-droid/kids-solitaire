import { api, esc, fmtDate, mountAppBar } from './app.js';

const id = new URLSearchParams(location.search).get('id');
const sheet = document.getElementById('sheet');

await mountAppBar({ title: '時間外受取シート', back: id ? `/detail?id=${encodeURIComponent(id)}` : '/list' });

if (!id) {
  sheet.innerHTML = '<p class="empty">引渡票が指定されていません。</p>';
  throw new Error('id が指定されていません');
}

document.getElementById('printBtn').addEventListener('click', () => window.print());
document.getElementById('detailLink').href = `/detail?id=${encodeURIComponent(id)}`;

const { handover: h } = await api(`/api/handovers/${encodeURIComponent(id)}`);
const { org, publicUrl } = await api('/api/config');

/* お客様のスマホは社内LANの外（モバイル回線）にいる。
   外から届くURLが設定されていないと、QRを読んでも何も開かない。 */
if (!publicUrl) {
  document.getElementById('warn').innerHTML = `
    <div class="note danger no-print">
      <strong>まだ使えません：お客様がアクセスできるURLが未設定です</strong>
      お客様のスマホは社内LANの外にあるため、社内アドレス（192.168.〜）では開けません。<br>
      サーバの環境変数 <b>HANDOVER_PUBLIC_URL</b> に、外から届くURLを設定してください。<br>
      （Windowsの場合は <b>start.bat</b> の先頭に
      <code>set "HANDOVER_PUBLIC_URL=https://〜"</code> を追記します）
    </div>`;
  document.getElementById('printBtn').disabled = true;
}

sheet.innerHTML = `
  <div class="pickup-head">
    <div class="title">お 引 取 り の お 客 様 へ</div>
    <div class="sub">${esc(org)}</div>
  </div>

  <div class="pickup-customer">
    <div class="name">${esc(h.customer_name)} 様</div>
    <div class="items">
      ${esc(h.item_desc || 'お荷物')}　<b>${esc(h.item_count)} 個</b>
      ${h.order_no ? `　／　受注番号 ${esc(h.order_no)}` : ''}
    </div>
  </div>

  <div class="pickup-main">
    <ol class="pickup-steps">
      <li><b>お荷物をご確認ください</b><br>品名と個数（${esc(h.item_count)}個）が合っているか、破損がないかをお確かめください。</li>
      <li><b>右のQRコードを読み取ってください</b><br>スマートフォンのカメラを向けると、確認画面が開きます。</li>
      <li><b>画面にサインをお願いします</b><br>受け取りの記録として残ります。</li>
      <li><b>送り状をお持ち帰りください</b><br>一緒に置いてある送り状をお忘れなく。</li>
    </ol>

    <div class="pickup-qr">
      <div class="cap">こ ち ら を 読 み 取 り</div>
      ${publicUrl
        ? `<img src="/qr/r/${encodeURIComponent(h.token)}.svg?mm=50"
                alt="受け取り手続き用のQRコード" width="189" height="189">`
        : `<div style="width:50mm;height:50mm;display:grid;place-items:center;border:1px dashed #000;font-size:12px">
             URL未設定のため<br>QRを作れません
           </div>`}
      <div class="hint">
        読み取れない場合は<br>お手数ですが窓口までご連絡ください
      </div>
    </div>
  </div>

  <div class="pickup-note">
    <b>お気づきの点があった場合</b><br>
    数が足りない・品名が違う・破損があるなど、お気づきの点があった場合は
    <b>お持ち帰りにならず</b>、窓口までご連絡ください。<br>
    ${h.pickup_until ? `引取期限：<b>${esc(fmtDate(h.pickup_until))}</b>` : ''}
  </div>

  <div class="pickup-foot">
    <span>${esc(h.token)}</span>
    <span>${esc(org)}</span>
  </div>
`;
sheet.setAttribute('aria-busy', 'false');
