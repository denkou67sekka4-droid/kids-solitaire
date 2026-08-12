/**
 * 引取場所で電波が届くかを、実際に測って判定する。
 *
 * 「つながる／つながらない」の二択では現場の実態に合わない。
 * いちばん困るのは「ふだんは開けるが、ときどき固まる」状態で、
 * これは一度開いただけでは分からない。
 * 連続して測り、取りこぼしの割合と速さで判断する。
 *
 * サーバの負担が軽い /health を叩く（業務データは一切返さない）。
 */
import { mountAppBar } from './app.js';

await mountAppBar({ title: '電波チェック', back: '/connect' });

const WINDOW = 40;        // 直近この回数で判定する
const INTERVAL = 700;     // 測る間隔(ms)
const TIMEOUT = 3000;     // これを超えたら失敗扱い
const SLOW = 400;         // これを超えたら「遅い」

const results = [];       // { ok, ms }
let running = true;
let timer = null;

const el = {
  verdict: document.getElementById('verdict'),
  bars: document.getElementById('bars'),
  rate: document.getElementById('rate'),
  avg: document.getElementById('avg'),
  worst: document.getElementById('worst'),
  toggle: document.getElementById('toggleBtn'),
  reset: document.getElementById('resetBtn'),
};

async function probe() {
  const started = performance.now();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), TIMEOUT);

  try {
    // キャッシュに当たると測定にならないので、毎回ちがうURLにする
    const res = await fetch(`/health?t=${Date.now()}`, { cache: 'no-store', signal: abort.signal });
    if (!res.ok) throw new Error(String(res.status));
    await res.json();
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: TIMEOUT };
  } finally {
    clearTimeout(timeout);
  }
}

function render() {
  const recent = results.slice(-WINDOW);
  const ok = recent.filter((r) => r.ok);
  const rate = recent.length ? Math.round((ok.length / recent.length) * 100) : 0;
  const avg = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;
  const worst = ok.length ? Math.max(...ok.map((r) => r.ms)) : 0;

  el.rate.textContent = recent.length ? `${rate}%` : '-';
  el.avg.textContent = ok.length ? avg : '-';
  el.worst.textContent = ok.length ? worst : '-';

  // 棒グラフ。遅いほど高く、失敗は最大の高さで赤く出す
  el.bars.innerHTML = recent
    .map((r) => {
      if (!r.ok) return '<i class="fail"></i>';
      const h = Math.max(8, Math.min(100, (r.ms / SLOW) * 60));
      return `<i class="${r.ms > SLOW ? 'slow' : ''}" style="height:${h}%"></i>`;
    })
    .join('');

  // 判定は測定回数がある程度たまってから
  if (recent.length < 8) return;

  let cls, mark, title, detail;
  if (rate >= 95 && avg < SLOW) {
    cls = 'good';
    mark = '◎';
    title = '良好';
    detail = 'この場所でそのまま使えます。';
  } else if (rate >= 80) {
    cls = 'weak';
    mark = '△';
    title = '不安定';
    detail =
      `${recent.length}回中 ${recent.length - ok.length}回つながりませんでした。<br>` +
      '使えますが、読み取りの途中で止まることがあります。<br>' +
      'Wi-Fi中継器を1台足すと安定します。';
  } else if (rate > 0) {
    cls = 'bad';
    mark = '×';
    title = 'ほとんど届いていません';
    detail =
      `${recent.length}回中 ${ok.length}回しかつながりませんでした。<br>` +
      'この場所での運用は難しいです。中継機かアクセスポイントが必要です。';
  } else {
    cls = 'bad';
    mark = '×';
    title = '届きません';
    detail =
      'サーバにつながりません。<br>' +
      'Wi-Fiにつながっているか、事務PCが起動しているかを確認してください。';
  }

  el.verdict.className = `verdict ${cls}`;
  el.verdict.innerHTML =
    `<div class="mark" aria-hidden="true">${mark}</div>` +
    `<div class="title">${title}</div>` +
    `<div class="detail">${detail}</div>`;
}

async function loop() {
  if (!running) return;
  results.push(await probe());
  if (results.length > WINDOW * 2) results.splice(0, results.length - WINDOW);
  render();
  timer = setTimeout(loop, INTERVAL);
}

el.toggle.addEventListener('click', () => {
  running = !running;
  el.toggle.textContent = running ? '一時停止' : '再開する';
  if (running) loop();
  else clearTimeout(timer);
});

el.reset.addEventListener('click', () => {
  results.length = 0;
  el.verdict.className = 'verdict';
  el.verdict.innerHTML =
    '<div class="mark" aria-hidden="true">…</div><div class="title">測定中</div>' +
    '<div class="detail">しばらくお待ちください</div>';
  render();
});

/* 画面を消している間は測っても意味がないので止める（電池のため） */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else if (running) loop();
});

loop();
