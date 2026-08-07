import { api, badge, esc, fmtDate, fmtDateTime, isOverdue, mountAppBar, toast } from './app.js';

await mountAppBar({ title: '一覧・履歴', back: '/' });

const PAGE = 50;
const form = document.getElementById('filterForm');
const rows = document.getElementById('rows');
const moreBtn = document.getElementById('moreBtn');
const emptyEl = document.getElementById('empty');

let offset = 0;

/* 検索条件はURLに残す。ブラウザの戻るで同じ結果に戻れるようにするため。 */
const params = new URLSearchParams(location.search);
form.q.value = params.get('q') ?? '';
form.status.value = params.get('status') ?? '';

function query() {
  const p = new URLSearchParams();
  if (form.q.value.trim()) p.set('q', form.q.value.trim());
  if (form.status.value) p.set('status', form.status.value);
  return p;
}

function render(items) {
  rows.insertAdjacentHTML(
    'beforeend',
    items
      .map((h) => {
        const overdue = isOverdue(h);
        return `<tr>
          <td>${badge(h.status)}${overdue ? '<br><span class="badge cancelled">期限超過</span>' : ''}</td>
          <td><span class="token">${esc(h.token)}</span></td>
          <td class="wrap"><b>${esc(h.customer_name)}</b>${h.customer_kana ? `<div class="hint">${esc(h.customer_kana)}</div>` : ''}</td>
          <td class="wrap">${esc(h.company)}</td>
          <td class="wrap">${esc(h.item_desc)}</td>
          <td>${esc(h.item_count)}</td>
          <td${overdue ? ' style="color:var(--danger);font-weight:700"' : ''}>${esc(fmtDate(h.pickup_until))}</td>
          <td>${esc(fmtDateTime(h.created_at))}</td>
          <td>
            <a class="btn" style="min-height:34px;padding:0 12px;font-size:13px" href="/detail?id=${h.id}">詳細</a>
            <a class="btn" style="min-height:34px;padding:0 12px;font-size:13px" href="/sheet?id=${h.id}">引渡票</a>
          </td>
        </tr>`;
      })
      .join('')
  );
}

async function load(reset) {
  if (reset) {
    offset = 0;
    rows.innerHTML = '';
  }
  moreBtn.disabled = true;

  try {
    const p = query();
    p.set('limit', String(PAGE));
    p.set('offset', String(offset));
    const { items, summary } = await api(`/api/handovers?${p}`);

    render(items);
    offset += items.length;

    emptyEl.hidden = offset > 0;
    moreBtn.hidden = items.length < PAGE;
    document.getElementById('summary').textContent =
      `全 ${summary.total} 件（未引渡 ${summary.issued} ／ 引渡済 ${summary.completed} ／ 取消 ${summary.cancelled}）`;
    document.getElementById('csvLink').href = `/api/export.csv?${query()}`;
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    moreBtn.disabled = false;
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = query().toString();
  history.replaceState(null, '', q ? `/list?${q}` : '/list');
  load(true);
});

moreBtn.addEventListener('click', () => load(false));

await load(true);
