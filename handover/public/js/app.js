/** 画面共通のユーティリティ */

export const STATUS_JA = { issued: '発行済', completed: '引渡済', cancelled: '取消' };

/* --- API 呼び出し -------------------------------------------------------- */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  // セッション切れは黙って落とさず、ログイン画面へ送る。
  // ただしログイン不要で開ける画面では飛ばさない
  // （電波チェックは、現場でセッションが切れていても使えなければ意味がない）。
  const PUBLIC_PATHS = ['/login', '/check', '/r/'];
  const isPublicPage = PUBLIC_PATHS.some((p) => location.pathname.startsWith(p));

  if (res.status === 401 && !isPublicPage) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('ログインが必要です');
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    const err = new Error(data?.error ?? `通信に失敗しました (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* --- 表示 ---------------------------------------------------------------- */

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

let toastTimer;
export function toast(message, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'err' ? 5000 : 2800);
}

/** ISO文字列を「2026/08/07 14:22」に */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(ymd) {
  return ymd ? ymd.replace(/-/g, '/') : '—';
}

export function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS_JA[status] ?? status)}</span>`;
}

/** 引取期限を過ぎているか（期限日の終わりまでを有効とする） */
export function isOverdue(h) {
  if (h.status !== 'issued' || !h.pickup_until) return false;
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return h.pickup_until < ymd;
}

/* --- 画面の枠 ------------------------------------------------------------ */

export async function mountAppBar({ title, back = null }) {
  const bar = document.querySelector('.appbar');
  if (!bar) return null;

  // 倉庫のWi-Fiは途切れる。ここで例外を投げるとページ全体が動かなくなるので、
  // 通信できなくても画面の枠だけは必ず出す。
  let user = null;
  try {
    ({ user } = await api('/api/me'));
  } catch {
    user = null;
  }

  bar.innerHTML = `
    ${back ? `<a class="back" href="${esc(back)}" aria-label="戻る">←</a>` : ''}
    <h1>${esc(title)}</h1>
    <div class="spacer"></div>
    <span class="offline" id="offlineFlag" hidden>圏外</span>
    ${user ? `<span class="who">${esc(user.displayName)}</span>
              <button class="btn ghost" id="logoutBtn" style="min-height:36px;padding:0 10px;color:#fff">ログアウト</button>` : ''}
  `;

  bar.querySelector('#logoutBtn')?.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // 通信できなくてもログイン画面には戻す
    }
    location.href = '/login';
  });

  // 電波が切れたことに気づかないまま作業が進むのがいちばん困る
  const flag = bar.querySelector('#offlineFlag');
  const sync = () => {
    flag.hidden = navigator.onLine;
    if (!navigator.onLine) toast('サーバに接続できません。電波状況を確認してください。', 'err');
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  flag.hidden = navigator.onLine;

  return user;
}

/** 引渡票の共通表示項目 */
export function handoverDefinitionList(h) {
  const rows = [
    ['引渡番号', `<span class="token">${esc(h.token)}</span>`],
    ['状態', badge(h.status) + (isOverdue(h) ? ' <span class="badge cancelled">期限超過</span>' : '')],
    ['お客様名', esc(h.customer_name) + (h.customer_kana ? `<div class="hint">${esc(h.customer_kana)}</div>` : '')],
    ['会社名', esc(h.company)],
    ['電話番号', h.phone ? `<a href="tel:${esc(h.phone)}">${esc(h.phone)}</a>` : ''],
    ['メール', esc(h.email)],
    ['受注番号', esc(h.order_no)],
    ['品名', esc(h.item_desc)],
    ['個数', `${h.item_count} 個`],
    ['保管場所', esc(h.storage_location)],
    ['引取可能日', fmtDate(h.pickup_from)],
    ['引取期限', fmtDate(h.pickup_until)],
    ['備考', esc(h.note).replace(/\n/g, '<br>')],
    ['発行', `${esc(h.issued_by)} / ${fmtDateTime(h.created_at)}`],
  ];
  if (h.completed_at) rows.push(['引渡日時', fmtDateTime(h.completed_at)]);

  return `<dl class="kv">${rows
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
}
