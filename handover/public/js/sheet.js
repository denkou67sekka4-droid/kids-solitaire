import { api, esc, fmtDate, fmtDateTime, mountAppBar, toast } from './app.js';

const id = new URLSearchParams(location.search).get('id');
const sheet = document.getElementById('sheet');

await mountAppBar({ title: '引渡票', back: '/list' });

if (!id) {
  sheet.innerHTML = '<p class="empty">引渡票が指定されていません。</p>';
  throw new Error('id が指定されていません');
}

document.getElementById('detailLink').href = `/detail?id=${encodeURIComponent(id)}`;
document.getElementById('labelsLink').href = `/labels?id=${encodeURIComponent(id)}`;
document.getElementById('printBtn').addEventListener('click', () => window.print());
document.getElementById('pdfBtn').addEventListener('click', () => {
  toast('印刷画面で「送信先」を［PDFに保存］にしてください');
  setTimeout(() => window.print(), 900);
});

const { handover: h } = await api(`/api/handovers/${encodeURIComponent(id)}`);
const { org } = await api('/api/config');

const png = document.getElementById('pngBtn');
png.href = `/qr/${encodeURIComponent(h.token)}.png?px=1200`;
png.download = `QR_${h.token}.png`;

const VOID_LABEL = { completed: '引 渡 済', cancelled: '取 消 済' };

const row = (label, value, cls = '') =>
  value ? `<tr><th>${esc(label)}</th><td class="${cls}">${esc(value)}</td></tr>` : '';

sheet.innerHTML = `
  ${VOID_LABEL[h.status] ? `<div class="sheet-void">こ の 引 渡 票 は ${VOID_LABEL[h.status]} で す</div>` : ''}

  <div class="sheet-head">
    <h1>荷 物 引 渡 票</h1>
    <div class="issuer">
      ${esc(org)}<br>
      発行日：${fmtDateTime(h.created_at)}<br>
      担当：${esc(h.issued_by)}
    </div>
  </div>

  <div class="sheet-main">
    <table>
      <tbody>
        ${row('お客様名', h.customer_name, 'big')}
        ${row('フリガナ', h.customer_kana)}
        ${row('会社名', h.company)}
        ${row('電話番号', h.phone)}
        ${row('受注番号', h.order_no)}
        ${row('品名', h.item_desc)}
        ${row('個数', `${h.item_count} 個`, 'big')}
        ${row('引取可能日', h.pickup_from ? fmtDate(h.pickup_from) : '')}
        ${row('引取期限', h.pickup_until ? fmtDate(h.pickup_until) : '')}
        ${row('備考', h.note)}
      </tbody>
    </table>

    <div class="qr-block">
      <div class="label">引 取 用 Q R コ ー ド</div>
      <img src="/qr/${encodeURIComponent(h.token)}.svg?mm=55" alt="引渡番号 ${esc(h.token)} のQRコード" width="208" height="208">
      <div class="token">${esc(h.token)}</div>
      <div class="token-note">QRが読み取れない場合は<br>この番号をお伝えください</div>
    </div>
  </div>

  <div class="sheet-guide">
    <h2>お引取りの際のお願い</h2>
    <ol>
      <li>この用紙（またはQRコードの画像）を、お引取り時に係員へご提示ください。</li>
      <li>係員がQRコードを読み取り、お荷物の内容を確認いたします。</li>
      <li>ご確認のうえ、係員の端末に受領のサインをお願いいたします。</li>
      ${h.pickup_until ? `<li>引取期限は <b>${esc(fmtDate(h.pickup_until))}</b> です。期限を過ぎる場合はご連絡ください。</li>` : ''}
    </ol>
  </div>

  <div class="sheet-foot">
    <span>引渡番号：${esc(h.token)}</span>
    <span>${esc(org)}</span>
  </div>
`;
sheet.setAttribute('aria-busy', 'false');
