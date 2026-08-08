import { api, esc, fmtDate, fmtDateTime, handoverDefinitionList, isOverdue, mountAppBar, toast } from './app.js';
import { QrScanner } from './scanner.js';
import { SignaturePad } from './signature.js';

await mountAppBar({ title: 'QR読み取り', back: '/' });

/* ------------------------------------------------------------------ *
 * 状態
 *
 * 引渡しは2段階の照合で成り立っている:
 *   1. お客様のQR  … 「誰に渡すか」を特定する
 *   2. 荷物のQR    … 「その人の荷物か」を1箱ずつ突き合わせる
 * 2 が全部そろって初めてサインに進める。
 * ------------------------------------------------------------------ */

const state = {
  phase: 'customer',   // customer → packages → sign → done
  handover: null,
  packages: [],
  scanned: new Set(),  // 読み取り済みの荷物ラベルの seq
  busy: false,
  cameraError: null,   // カメラが使えない理由（使えていれば null）
};

const el = {
  stages: {
    scan: document.getElementById('scanStage'),
    sign: document.getElementById('signStage'),
    done: document.getElementById('doneView'),
  },
  steps: document.getElementById('steps'),
  scanner: document.querySelector('.scanner'),
  scannerMsg: document.getElementById('scannerMsg'),
  torchBtn: document.getElementById('torchBtn'),
  alert: document.getElementById('scanAlert'),
  context: document.getElementById('scanContext'),
  manualInput: document.getElementById('manualToken'),
  restartBtn: document.getElementById('restartBtn'),
  receiveForm: document.getElementById('receiveForm'),
  completeBtn: document.getElementById('completeBtn'),
  signArea: document.querySelector('.sign-area'),
};

/* サイン欄はカメラより先に用意しておく。
   カメラ起動直後にQRが読めると描画処理が走るため、後に置くと未初期化になる。 */
const pad = new SignaturePad(document.getElementById('signCanvas'), {
  onChange: (p) => {
    el.signArea.classList.toggle('dirty', !p.isEmpty);
    el.completeBtn.disabled = p.isEmpty;
  },
});

document.getElementById('clearBtn').addEventListener('click', () => pad.clear());
document.getElementById('undoBtn').addEventListener('click', () => pad.undo());
document.getElementById('backToScanBtn').addEventListener('click', () => setPhase('packages'));
document.getElementById('receiverRelation').addEventListener('change', () => {
  syncReceiverFields();
  if (document.getElementById('receiverRelation').value === 'agent') {
    document.getElementById('receiverName').focus();
  }
});
document.getElementById('againBtn').addEventListener('click', reset);
el.restartBtn.addEventListener('click', reset);

/* ------------------------------------------------------------------ *
 * 画面の切り替え
 * ------------------------------------------------------------------ */

const STAGE_OF_PHASE = { customer: 'scan', packages: 'scan', sign: 'sign', done: 'done' };
const STEP_ORDER = ['customer', 'packages', 'sign'];

function setPhase(phase) {
  state.phase = phase;

  const stage = STAGE_OF_PHASE[phase];
  for (const [name, node] of Object.entries(el.stages)) node.hidden = name !== stage;

  // 手順表示
  const index = STEP_ORDER.indexOf(phase === 'done' ? 'sign' : phase);
  for (const li of el.steps.children) {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('active', i === index && phase !== 'done');
    li.classList.toggle('done', i < index || phase === 'done');
  }

  el.restartBtn.hidden = phase === 'customer';

  if (stage === 'scan') {
    // カメラが使えないときは、案内文で理由を塗りつぶさない
    if (!state.cameraError) {
      el.scannerMsg.textContent =
        phase === 'customer' ? 'お客様のQRコードを枠内に写してください' : '荷物のQRコードを1箱ずつ写してください';
    }
    scanner.resume();
  } else {
    scanner.pause();
  }

  renderContext();
  if (phase === 'sign') renderSignStage();
  window.scrollTo(0, 0);
}

/** サイン画面に入るときに、確認内容と照合結果を出しておく */
function renderSignStage() {
  const h = state.handover;
  if (!h) return;

  document.getElementById('signHandoverInfo').innerHTML = handoverDefinitionList(h);

  const total = state.packages.length;
  const done = state.scanned.size;
  const missing = state.packages.filter((p) => !state.scanned.has(p.seq)).map((p) => `${p.seq}番`);

  document.getElementById('signPackageSummary').innerHTML = total
    ? `<div class="note ${done === total ? 'ok' : 'warn'}">
         <strong>荷物の照合：${done} / ${total} 箱</strong>
         ${done === total
           ? 'すべての荷物のQRを確認しました。'
           : `未確認：${esc(missing.join('、'))}<br>理由：${esc(overrideReason)}`}
       </div>`
    : '';

  syncReceiverFields();
}

/**
 * サインするのは「実際に引き取りに来た人」であって、伝票上のお客様とは限らない。
 * ご本人ならお名前を先に入れておくが、代理の方に切り替えたら必ず入力し直させる。
 * （初期値のまま確定されると、来ていない人の名前で受領記録が残ってしまう）
 */
function syncReceiverFields() {
  const h = state.handover;
  if (!h) return;

  const relation = document.getElementById('receiverRelation').value;
  const nameInput = document.getElementById('receiverName');
  const hint = document.getElementById('receiverHint');
  const prompt = document.getElementById('signPrompt');

  if (relation === 'agent') {
    if (nameInput.value === h.customer_name) nameInput.value = '';
    nameInput.placeholder = '例）山田運送 佐藤';
    hint.textContent = `お客様（${h.customer_name} 様）に代わって引き取りに来られた方のお名前を入力してください。`;
    prompt.textContent = '代理でお引取りの方';
  } else {
    if (!nameInput.value) nameInput.value = h.customer_name;
    nameInput.placeholder = '';
    hint.textContent = '';
    prompt.textContent = '引き取られるご本人';
  }
}

/** 受領者の入力欄を空に戻す。お客様が変わるたびに必ず通す。 */
function clearReceiveForm() {
  document.getElementById('receiverName').value = '';
  document.getElementById('receiverRelation').value = 'self';
  document.getElementById('receiveNote').value = '';
  pad.clear();
}

function reset() {
  state.handover = null;
  state.packages = [];
  state.scanned = new Set();
  clearReceiveForm();
  el.alert.innerHTML = '';
  el.manualInput.value = '';
  el.scanner.classList.remove('found', 'mismatch');
  setPhase('customer');
}

/* ------------------------------------------------------------------ *
 * 読み取り中の表示
 * ------------------------------------------------------------------ */

function renderContext() {
  if (state.phase === 'customer' || !state.handover) {
    el.context.innerHTML = '';
    return;
  }

  const h = state.handover;
  const total = state.packages.length;
  const done = state.scanned.size;
  const complete = total > 0 && done === total;

  el.context.innerHTML = `
    <div class="card">
      <h2>お客様</h2>
      <dl class="kv">
        <dt>お客様名</dt><dd><b style="font-size:18px">${esc(h.customer_name)} 様</b></dd>
        ${h.company ? `<dt>会社名</dt><dd>${esc(h.company)}</dd>` : ''}
        ${h.order_no ? `<dt>受注番号</dt><dd>${esc(h.order_no)}</dd>` : ''}
        ${h.item_desc ? `<dt>品名</dt><dd>${esc(h.item_desc)}</dd>` : ''}
        ${h.storage_location ? `<dt>保管場所</dt><dd>${esc(h.storage_location)}</dd>` : ''}
      </dl>
    </div>

    <div class="card">
      <h2>荷物の照合</h2>
      <div class="pkg-progress ${complete ? 'complete' : ''}">
        <b>${done} / ${total}</b>
        <span>${complete ? '箱すべて確認できました' : '箱を読み取り済み'}</span>
      </div>
      <div class="pkg-list">
        ${state.packages
          .map((p) => `
            <div class="pkg ${state.scanned.has(p.seq) ? 'done' : 'pending'}">
              <span class="mark" aria-hidden="true"></span>
              <span class="seq">${p.seq}</span>
            </div>`)
          .join('')}
      </div>
      ${complete
        ? `<div class="actions"><button class="btn primary big" type="button" id="toSignBtn">サインに進む</button></div>`
        : `<p class="hint" style="margin-top:12px">
             残り ${total - done} 箱の荷物ラベルを読み取ってください。
           </p>
           <div class="actions">
             <button class="btn" type="button" id="partialBtn">一部だけ引き渡す</button>
           </div>`}
    </div>
  `;

  document.getElementById('toSignBtn')?.addEventListener('click', () => setPhase('sign'));
  document.getElementById('partialBtn')?.addEventListener('click', partialHandover);
}

/** そろっていない箱があるまま引き渡すとき。理由を必ず残す。 */
let overrideReason = '';
function partialHandover() {
  const missing = state.packages.filter((p) => !state.scanned.has(p.seq)).map((p) => p.seq);
  const reason = prompt(
    `未確認の荷物: ${missing.join(', ')} 番（全${state.packages.length}箱）\n\n` +
    'そろっていない理由を入力してください。履歴に残ります。'
  );
  if (reason === null) return;
  if (!reason.trim()) {
    toast('理由の入力が必要です', 'err');
    return;
  }
  overrideReason = reason.trim();
  setPhase('sign');
}

function showAlert(kind, title, detail = '') {
  el.alert.innerHTML =
    `<div class="alert-big ${kind}">${esc(title)}${detail ? `<small>${detail}</small>` : ''}</div>`;
}

/* ------------------------------------------------------------------ *
 * カメラ
 * ------------------------------------------------------------------ */

const scanner = new QrScanner(document.getElementById('video'), {
  onStatus: (msg) => (el.scannerMsg.textContent = msg),
  onResult: (value) => handleScan(value),
});

try {
  await scanner.start();
  if (scanner.hasTorch) {
    el.torchBtn.hidden = false;
    el.torchBtn.addEventListener('click', async () => {
      const on = el.torchBtn.getAttribute('aria-pressed') !== 'true';
      if (await scanner.setTorch(on)) el.torchBtn.setAttribute('aria-pressed', String(on));
    });
  }
} catch (err) {
  // カメラが使えなくても、番号の手入力だけで引渡し作業は成立する。
  // 画面を止めず、理由を出したうえで手入力へ誘導する。
  //
  // ここで行き止まりにしないことが大事。スマホを持っているのは倉庫の人で、
  // 事務PCの画面は見られない。対処方法へ自力でたどり着けるようにしておく。
  state.cameraError = err.message;
  el.scanner.classList.add('unavailable');
  el.scannerMsg.innerHTML =
    `${esc(err.message)}<br>` +
    `<a href="/connect" style="color:#9ecbff;font-weight:700;display:inline-block;margin-top:8px">` +
    `カメラを使えるようにする方法を見る</a>`;
  el.manualInput.focus();
}

/** 読み取れたときの手応え。倉庫では画面を見ていないことがある。 */
function beep(kind) {
  navigator.vibrate?.(kind === 'ok' ? 80 : [90, 70, 90, 70, 160]);
  try {
    const ac = new (window.AudioContext ?? window.webkitAudioContext)();
    const play = (freq, start, dur) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, ac.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime + start);
      osc.stop(ac.currentTime + start + dur);
    };
    if (kind === 'ok') play(880, 0, 0.18);
    else { play(220, 0, 0.22); play(180, 0.26, 0.34); } // 低く長い音＝異常
    setTimeout(() => ac.close(), 900);
  } catch {
    // 音が出せなくても支障はない
  }
}

document.getElementById('manualForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = el.manualInput.value.trim();
  if (v) handleScan(v, { manual: true });
});

/* ------------------------------------------------------------------ *
 * 読み取り結果の振り分け
 * ------------------------------------------------------------------ */

/**
 * カメラ由来の読み取りは、処理中なら捨ててよい（次のフレームでまた読める）。
 * 手入力は捨てると「押したのに何も起きない」になるので、必ず順番待ちさせる。
 */
let scanQueue = Promise.resolve();

function handleScan(raw, { manual = false } = {}) {
  if (!manual && state.busy) return scanQueue;
  scanQueue = scanQueue.then(() => runScan(raw));
  return scanQueue;
}

async function runScan(raw) {
  state.busy = true;
  scanner.pause();

  try {
    const result = await api(`/api/lookup?token=${encodeURIComponent(raw)}`);
    if (state.phase === 'customer') acceptCustomer(result);
    else acceptPackage(result);
    el.manualInput.value = '';
  } catch (err) {
    beep('err');
    showAlert('stop', '読み取れませんでした', esc(err.message));
  } finally {
    state.busy = false;
    el.scanner.classList.remove('found', 'mismatch');
    if (STAGE_OF_PHASE[state.phase] === 'scan') scanner.resume();
  }
}

/** 手順1: お客様のQR */
function acceptCustomer({ kind, handover, packages, package: pkg }) {
  if (kind === 'package') {
    beep('err');
    showAlert(
      'warn',
      'これは荷物のQRです',
      `先に<b>お客様のQRコード</b>を読み取ってください。<br>` +
      `（この荷物は ${esc(handover.customer_name)} 様の ${pkg.seq}箱目です）`
    );
    return;
  }

  if (handover.status !== 'issued') {
    beep('err');
    showAlert(
      'stop',
      handover.status === 'completed' ? 'この荷物は既に引渡し済みです' : 'この引渡票は取消されています',
      handover.status === 'completed'
        ? `引渡日時：${esc(fmtDateTime(handover.completed_at))}<br>二重渡しの恐れがあります。事務所に確認してください。`
        : 'お渡しせず、事務所に確認してください。'
    );
    return;
  }

  beep('ok');
  state.handover = handover;
  state.packages = packages;
  state.scanned = new Set();
  overrideReason = '';

  // 前のお客様の入力が残っていると、別人の名前で受領記録が残ってしまう
  clearReceiveForm();

  el.alert.innerHTML = '';
  if (isOverdue(handover)) {
    showAlert('warn', '引取期限を過ぎています',
      `期限：${esc(fmtDate(handover.pickup_until))}<br>お渡しして問題ないか確認してください。`);
  }

  // ラベルが1枚も無い引渡票（旧データなど）は荷物照合を飛ばす
  setPhase(packages.length ? 'packages' : 'sign');
}

/** 手順2: 荷物のQR */
function acceptPackage({ kind, handover, package: pkg }) {
  if (kind === 'handover') {
    if (handover.id === state.handover.id) {
      beep('err');
      showAlert('warn', 'お客様のQRは読み取り済みです', '次は<b>荷物のQRコード</b>を読み取ってください。');
    } else {
      beep('err');
      showAlert('stop', '別のお客様のQRです',
        `${esc(handover.customer_name)} 様のQRコードが読み取られました。<br>` +
        `切り替える場合は［最初からやり直す］を押してください。`);
    }
    return;
  }

  // これが二重チェックの本体。別の引渡票に属する荷物なら止める。
  if (pkg.handover_id !== state.handover.id) {
    beep('err');
    el.scanner.classList.add('mismatch');
    showAlert('stop', '別のお客様の荷物です',
      `この荷物は <b>${esc(handover.customer_name)} 様</b> の ${pkg.seq}箱目です。<br>` +
      `いま対応中のお客様は <b>${esc(state.handover.customer_name)} 様</b> です。<br>` +
      `お渡ししないでください。`);
    return;
  }

  if (state.scanned.has(pkg.seq)) {
    beep('err');
    showAlert('warn', `${pkg.seq}箱目は読み取り済みです`,
      `${state.scanned.size} / ${state.packages.length} 箱を確認済みです。まだ読んでいない箱を読み取ってください。`);
    return;
  }

  beep('ok');
  state.scanned.add(pkg.seq);
  el.alert.innerHTML = '';
  renderContext();

  // 全部そろったら自動でサインへ進む
  if (state.scanned.size === state.packages.length) setPhase('sign');
}

/* ------------------------------------------------------------------ *
 * サイン → 確定
 * ------------------------------------------------------------------ */

el.receiveForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!state.handover || state.busy) return;

  if (pad.isEmpty) return toast('サインを記入してください', 'err');

  const receiverName = document.getElementById('receiverName').value.trim();
  if (!receiverName) return toast('受領者のお名前を入力してください', 'err');

  state.busy = true;
  el.completeBtn.disabled = true;
  el.completeBtn.textContent = '送信中…';

  try {
    const { handover } = await api(`/api/handovers/${state.handover.id}/complete`, {
      method: 'POST',
      body: {
        receiverName,
        receiverRelation: document.getElementById('receiverRelation').value,
        note: document.getElementById('receiveNote').value,
        signature: pad.toDataUrl(),
        packageTokens: state.packages.filter((p) => state.scanned.has(p.seq)).map((p) => p.token),
        overrideReason,
      },
    });

    renderDone(handover, receiverName);
    setPhase('done');
    navigator.vibrate?.([60, 50, 60]);
  } catch (err) {
    toast(err.message, 'err');
    el.completeBtn.disabled = false;
  } finally {
    state.busy = false;
    el.completeBtn.textContent = '引渡しを確定する';
  }
});

function renderDone(h, receiverName) {
  document.getElementById('doneSummary').textContent =
    `${h.customer_name} 様 ／ ${state.scanned.size}/${state.packages.length} 箱 ／ 受領：${receiverName} 様`;
  document.getElementById('doneInfo').innerHTML = handoverDefinitionList(h);
}

/* 画面を離れるときはカメラを確実に止める（電池とプライバシーのため） */
window.addEventListener('pagehide', () => scanner.stop());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner.pause();
  else if (STAGE_OF_PHASE[state.phase] === 'scan' && !state.busy) scanner.resume();
});

setPhase('customer');
