/**
 * お客様セルフ受取（時間外）。
 *
 * 社内の画面と違い、使うのは初めて見るお客様。しかもたいてい夜。
 * ・ログインは無い。URLに入っている番号だけで開く
 * ・専門用語を出さない（引渡票・照合・引渡番号 → 使わない）
 * ・確認 → サイン → 完了 の3画面だけに絞る
 */
import { esc, fmtDate, toast } from './app.js';
import { SignaturePad } from './signature.js';

const token = decodeURIComponent(location.pathname.replace(/^\/r\//, '').replace(/\/+$/, ''));
const content = document.getElementById('content');

/** 公開画面用の通信。ログイン画面に飛ばす処理は挟まない。 */
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error ?? '通信できませんでした。電波の良い場所でお試しください。');
    err.status = res.status;
    throw err;
  }
  return data;
}

function message(icon, title, detail) {
  content.innerHTML = `
    <div class="card big-message">
      <div class="icon" aria-hidden="true">${icon}</div>
      <h2>${esc(title)}</h2>
      <p>${detail}</p>
    </div>`;
  content.setAttribute('aria-busy', 'false');
}

/* ------------------------------------------------------------------ *
 * 1. 内容の確認
 * ------------------------------------------------------------------ */

function renderConfirm(h, org) {
  content.innerHTML = `
    <div class="card">
      <p class="receive-step">STEP 1 / 2</p>
      <h2 class="lead">お荷物をご確認ください</h2>

      <div class="goods">
        <div class="name">${esc(h.itemDesc || 'お荷物')}</div>
        <div class="count">${esc(h.itemCount)} 個</div>
        <dl>
          <dt>お名前</dt><dd>${esc(h.customerName)} 様</dd>
          ${h.company ? `<dt>会社名</dt><dd>${esc(h.company)}</dd>` : ''}
          ${h.orderNo ? `<dt>受注番号</dt><dd>${esc(h.orderNo)}</dd>` : ''}
          ${h.storageLocation ? `<dt>お渡し場所</dt><dd>${esc(h.storageLocation)}</dd>` : ''}
          ${h.note ? `<dt>備考</dt><dd>${esc(h.note).replace(/\n/g, '<br>')}</dd>` : ''}
        </dl>
      </div>

      <ol class="check-list">
        <li>品名と<b>個数（${esc(h.itemCount)}個）</b>が合っているかご確認ください</li>
        <li>外装に破損がないかご確認ください</li>
        <li>お間違いがなければ、下のボタンへお進みください</li>
      </ol>

      <div class="note warn">
        数が足りない・品名が違う・破損があるなど、<b>お気づきの点があった場合は
        お持ち帰りにならず</b>、窓口までご連絡ください。
      </div>

      <button class="btn primary big" type="button" id="toSign">確認しました（次へ）</button>
    </div>`;
  content.setAttribute('aria-busy', 'false');

  document.getElementById('toSign').addEventListener('click', () => renderSign(h, org));
}

/* ------------------------------------------------------------------ *
 * 2. サイン
 * ------------------------------------------------------------------ */

function renderSign(h, org) {
  content.innerHTML = `
    <div class="card">
      <p class="receive-step">STEP 2 / 2</p>
      <h2 class="lead">受け取りのサインをお願いします</h2>

      <div style="margin-bottom:16px">
        <label for="receiverName">お受け取りの方のお名前 <span class="req" aria-hidden="true">*</span></label>
        <input id="receiverName" maxlength="100" autocomplete="name" value="${esc(h.customerName)}">
      </div>

      <div style="margin-bottom:16px">
        <label for="receiverRelation">お受け取りの方</label>
        <select id="receiverRelation">
          <option value="self">ご本人</option>
          <option value="agent">代理の方</option>
        </select>
      </div>

      <label>サイン <span class="req" aria-hidden="true">*</span></label>
      <div class="sign-area">
        <canvas id="signCanvas" aria-label="サイン記入欄"></canvas>
        <div class="sign-baseline" aria-hidden="true"></div>
        <span class="sign-placeholder">ここに指でサインしてください</span>
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn" type="button" id="undoBtn">ひとつ戻す</button>
        <button class="btn" type="button" id="clearBtn">全部消す</button>
      </div>

      <div class="actions" style="margin-top:22px">
        <button class="btn" type="button" id="backBtn">戻る</button>
        <button class="btn primary big" type="button" id="submitBtn" style="flex:1" disabled>
          受け取りを確定する
        </button>
      </div>
    </div>`;
  content.setAttribute('aria-busy', 'false');

  const area = document.querySelector('.sign-area');
  const submitBtn = document.getElementById('submitBtn');

  const pad = new SignaturePad(document.getElementById('signCanvas'), {
    onChange: (p) => {
      area.classList.toggle('dirty', !p.isEmpty);
      submitBtn.disabled = p.isEmpty;
    },
  });

  document.getElementById('clearBtn').addEventListener('click', () => pad.clear());
  document.getElementById('undoBtn').addEventListener('click', () => pad.undo());
  document.getElementById('backBtn').addEventListener('click', () => {
    pad.destroy();
    renderConfirm(h, org);
  });

  document.getElementById('receiverRelation').addEventListener('change', (ev) => {
    // 代理の方なら、お客様名のままにせず入力し直していただく
    const name = document.getElementById('receiverName');
    if (ev.target.value === 'agent' && name.value === h.customerName) {
      name.value = '';
      name.focus();
    } else if (ev.target.value === 'self' && !name.value) {
      name.value = h.customerName;
    }
  });

  submitBtn.addEventListener('click', async () => {
    const receiverName = document.getElementById('receiverName').value.trim();
    if (!receiverName) return toast('お名前をご記入ください', 'err');
    if (pad.isEmpty) return toast('サインをご記入ください', 'err');

    submitBtn.disabled = true;
    submitBtn.textContent = '送信中…';

    try {
      const { handover } = await call(`/api/r/${encodeURIComponent(token)}/receive`, {
        method: 'POST',
        body: {
          receiverName,
          receiverRelation: document.getElementById('receiverRelation').value,
          signature: pad.toDataUrl(),
        },
      });
      pad.destroy();
      renderDone(handover, receiverName);
      navigator.vibrate?.([60, 50, 60]);
    } catch (err) {
      toast(err.message, 'err');
      submitBtn.disabled = false;
      submitBtn.textContent = '受け取りを確定する';
      // 既に受け取り済みになっていた場合は、その旨の画面に切り替える
      if (err.status === 409) setTimeout(() => start(), 1500);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 3. 完了
 * ------------------------------------------------------------------ */

function renderDone(h, receiverName) {
  content.innerHTML = `
    <div class="done-mark" aria-hidden="true">✓</div>
    <div class="note ok" style="text-align:center;font-size:17px">
      <strong style="font-size:22px">受け取りを承りました</strong>
      ${esc(h.itemDesc || 'お荷物')} ${esc(h.itemCount)}個<br>
      ${esc(receiverName)} 様
    </div>
    <div class="card">
      <p style="margin:0;line-height:1.9">
        お手続きは以上です。ありがとうございました。<br>
        <b>送り状はお忘れなくお持ち帰りください。</b>
      </p>
    </div>`;
  content.setAttribute('aria-busy', 'false');
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

async function start() {
  try {
    const { handover: h, org } = await call(`/api/r/${encodeURIComponent(token)}`);

    document.getElementById('orgName').textContent = org;
    document.getElementById('footOrg').textContent = org;

    if (h.status === 'completed') {
      return message('✅', 'お受け取り済みです',
        'このお荷物は受け取り済みとして記録されています。<br>' +
        'お心当たりのない場合は、窓口までご連絡ください。');
    }
    if (h.status === 'cancelled') {
      return message('⚠️', 'このお手続きは無効です',
        'お手数ですが、窓口までご連絡ください。');
    }

    if (h.pickupUntil && h.pickupUntil < new Date().toISOString().slice(0, 10)) {
      // 期限切れでも受け取り自体は止めない（現物が置いてあるため）が、注意は出す
      toast(`引取期限（${fmtDate(h.pickupUntil)}）を過ぎています`, 'err');
    }

    renderConfirm(h, org);
  } catch (err) {
    message('⚠️', 'お手続きの情報が見つかりません', esc(err.message));
  }
}

await start();
