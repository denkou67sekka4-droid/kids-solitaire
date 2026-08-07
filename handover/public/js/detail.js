import { api, esc, fmtDateTime, handoverDefinitionList, mountAppBar, toast } from './app.js';

const id = new URLSearchParams(location.search).get('id');
const content = document.getElementById('content');

await mountAppBar({ title: '引渡票の詳細', back: '/list' });

if (!id) {
  content.innerHTML = '<p class="empty">引渡票が指定されていません。</p>';
  throw new Error('id が指定されていません');
}

const EVENT_JA = {
  issued: '発行',
  scanned: 'QR照会',
  completed: '引渡し完了',
  self_received: '引渡し完了（時間外・お客様セルフ受取）',
  cancelled: '取消',
  edited: '内容を編集',
};

const RELATION_JA = { self: 'ご本人', agent: '代理の方' };

async function load() {
  content.setAttribute('aria-busy', 'true');
  const { handover: h, packages, events } = await api(`/api/handovers/${encodeURIComponent(id)}`);
  const signed = events.find((e) => ['completed', 'self_received'].includes(e.type) && e.has_signature);
  const selfReceived = signed?.type === 'self_received';

  // 引渡し時にどの箱を照合したか
  let scannedSeqs = [];
  try {
    scannedSeqs = signed?.packages_scanned ? JSON.parse(signed.packages_scanned) : [];
  } catch {
    scannedSeqs = [];
  }

  content.innerHTML = `
    <div class="card">
      <h2>引渡票</h2>
      ${handoverDefinitionList(h)}
      <div class="actions">
        <a class="btn primary" href="/sheet?id=${h.id}">引渡票を表示（印刷・FAX）</a>
        <a class="btn primary" href="/labels?id=${h.id}">荷物ラベルを印刷</a>
        ${h.status === 'issued' ? `<a class="btn" href="/pickup-sheet?id=${h.id}">時間外受取シートを印刷</a>` : ''}
        ${h.status === 'issued' ? `<a class="btn" href="/issue?id=${h.id}">編集</a>` : ''}
        ${h.status === 'issued' ? `<button class="btn danger" id="cancelBtn">この引渡票を取消</button>` : ''}
      </div>
    </div>

    ${packages.length ? `
      <div class="card">
        <h2>荷物ラベル（全 ${packages.length} 箱）</h2>
        ${signed ? `<p class="hint" style="margin-top:-8px">
          引渡し時に照合できた箱：<b>${scannedSeqs.length} / ${packages.length}</b>
        </p>` : ''}
        <div class="table-wrap">
          <table>
            <thead><tr><th>箱</th><th>ラベル番号</th>${signed ? '<th>引渡時の照合</th>' : ''}</tr></thead>
            <tbody>
              ${packages.map((p) => `
                <tr>
                  <td>${p.seq} / ${packages.length}</td>
                  <td><span class="token">${esc(p.token)}</span></td>
                  ${signed
                    ? `<td>${scannedSeqs.includes(p.seq)
                        ? '<span class="badge completed">照合済</span>'
                        : '<span class="badge cancelled">未照合</span>'}</td>`
                    : ''}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

    ${signed ? `
      <div class="card">
        <h2>受領サイン</h2>
        ${selfReceived ? `
          <div class="note warn">
            <strong>時間外・お客様セルフ受取</strong>
            お客様ご自身が、ワゴンのQRから受け取りを記録されたものです。<br>
            <b>係員による荷物の照合（荷物ラベルの読み取り）は行われていません。</b>
          </div>` : ''}
        <dl class="kv" style="margin-bottom:14px">
          <dt>受領者</dt><dd><b>${esc(signed.receiver_name)}</b>（${esc(RELATION_JA[signed.receiver_relation] ?? signed.receiver_relation)}）</dd>
          <dt>受領日時</dt><dd>${esc(fmtDateTime(signed.at))}</dd>
          <dt>対応者</dt><dd>${esc(signed.actor)}</dd>
          ${signed.note ? `<dt>備考</dt><dd>${esc(signed.note)}</dd>` : ''}
        </dl>
        <div class="sig-box">
          <img src="/api/events/${signed.id}/signature.png" alt="${esc(signed.receiver_name)} 様の受領サイン">
        </div>
      </div>` : ''}

    <div class="card">
      <h2>履歴</h2>
      <ul class="timeline">
        ${events.map((e) => `
          <li>
            <div class="when">${esc(fmtDateTime(e.at))}</div>
            <div class="what">${esc(EVENT_JA[e.type] ?? e.type)}</div>
            <div>
              ${e.actor ? `担当：${esc(e.actor)}` : ''}
              ${e.receiver_name ? ` ／ 受領：${esc(e.receiver_name)}` : ''}
            </div>
            ${e.note ? `<div>${esc(e.note)}</div>` : ''}
            ${e.user_agent ? `<div class="hint">${esc(e.user_agent)}</div>` : ''}
            ${e.type === 'completed' && e.record_hash
              ? `<div class="hash" title="引渡し時点の記載内容のSHA-256。後から内容が書き換えられていないことの確認に使えます。">
                   記録ハッシュ: ${esc(e.record_hash)}
                 </div>` : ''}
          </li>`).join('')}
      </ul>
    </div>
  `;
  content.setAttribute('aria-busy', 'false');

  document.getElementById('cancelBtn')?.addEventListener('click', async (ev) => {
    const note = prompt('取消の理由を入力してください（任意）');
    if (note === null) return; // ダイアログでキャンセルされた
    ev.target.disabled = true;
    try {
      await api(`/api/handovers/${h.id}/cancel`, { method: 'POST', body: { note } });
      toast('取消しました', 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'err');
      ev.target.disabled = false;
    }
  });
}

try {
  await load();
} catch (err) {
  content.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
}
