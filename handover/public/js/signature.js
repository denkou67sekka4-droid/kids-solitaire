/**
 * 指でサインしてもらうためのキャンバス。
 *
 * 気をつけている点:
 *  - Pointer Events を使い、指・スタイラス・マウスを同じ経路で扱う
 *  - touch-action:none にしないと、書いている最中にページがスクロールしてしまう
 *  - devicePixelRatio を掛けて描かないと、高解像度スマホで線がぼやける
 *  - 線は「点を直線でつなぐ」のではなく中点を通す二次ベジェにする。
 *    直線つなぎだと指の速い動きがカクカクの折れ線になり、署名らしくならない
 *  - 筆速で線幅を変える。速く動かすほど細くなり、手書きらしい強弱が出る
 */
export class SignaturePad {
  #canvas;
  #ctx;
  #strokes = [];      // 確定した線（undo 用に保持）
  #current = null;
  #dpr = 1;
  #onChange;

  constructor(canvas, { onChange } = {}) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d', { willReadFrequently: false });
    this.#onChange = onChange ?? (() => {});

    canvas.style.touchAction = 'none';
    this.resize();

    canvas.addEventListener('pointerdown', this.#down);
    canvas.addEventListener('pointermove', this.#move);
    canvas.addEventListener('pointerup', this.#up);
    canvas.addEventListener('pointercancel', this.#up);
    canvas.addEventListener('pointerleave', this.#up);

    // 画面回転などで幅が変わったら描き直す
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
  }

  destroy() {
    this._ro?.disconnect();
  }

  /** CSS上の大きさに合わせて実ピクセル数を取り直し、既存の線を描き直す */
  resize() {
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.#canvas.width === w && this.#canvas.height === h) return;

    this.#dpr = dpr;
    this.#canvas.width = w;
    this.#canvas.height = h;
    this.#redraw();
  }

  #point(ev) {
    const r = this.#canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * this.#dpr,
      y: (ev.clientY - r.top) * this.#dpr,
      t: ev.timeStamp,
    };
  }

  #down = (ev) => {
    if (ev.button != null && ev.button !== 0) return; // 右クリック等は無視
    ev.preventDefault();
    this.#canvas.setPointerCapture(ev.pointerId);
    this.#current = { points: [this.#point(ev)], widths: [] };
  };

  #move = (ev) => {
    if (!this.#current) return;
    ev.preventDefault();

    // 対応端末では中間座標も拾い、速い動きでも点が飛ばないようにする
    const events = ev.getCoalescedEvents?.() ?? [ev];
    for (const e of events) this.#current.points.push(this.#point(e));
    this.#redraw();
  };

  #up = (ev) => {
    if (!this.#current) return;
    ev?.preventDefault?.();
    if (this.#current.points.length) this.#strokes.push(this.#current);
    this.#current = null;
    this.#redraw();
    this.#onChange(this);
  };

  /** 筆速から線幅を決める（速い＝細い） */
  #widthAt(p0, p1) {
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const dt = Math.max(p1.t - p0.t, 1);
    const v = dist / dt;
    const base = 2.6 * this.#dpr;
    return Math.max(base * 0.45, Math.min(base * 1.5, base * 1.5 - v * 1.4 * this.#dpr));
  }

  #drawStroke(stroke) {
    const ctx = this.#ctx;
    const pts = stroke.points;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#101828';

    if (pts.length === 1) {
      // 点を打っただけの場合も見えるようにする
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 1.4 * this.#dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#101828';
      ctx.fill();
      return;
    }

    // 各区間を「前後の中点を結ぶ二次ベジェ」で描く
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const midA = i === 1 ? prev : { x: (pts[i - 2].x + prev.x) / 2, y: (pts[i - 2].y + prev.y) / 2 };
      const midB = { x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 };

      ctx.beginPath();
      ctx.lineWidth = this.#widthAt(prev, cur);
      ctx.moveTo(midA.x, midA.y);
      ctx.quadraticCurveTo(prev.x, prev.y, midB.x, midB.y);
      ctx.stroke();
    }

    // 最後の中点から終点までを繋いで線を閉じる
    const last = pts.at(-1);
    const beforeLast = pts.at(-2);
    ctx.beginPath();
    ctx.lineWidth = this.#widthAt(beforeLast, last);
    ctx.moveTo((beforeLast.x + last.x) / 2, (beforeLast.y + last.y) / 2);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  #redraw() {
    const ctx = this.#ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 保存時に背景を透明にすると印刷で見えないことがあるので、白で塗っておく
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    for (const s of this.#strokes) this.#drawStroke(s);
    if (this.#current) this.#drawStroke(this.#current);
    ctx.restore();
  }

  clear() {
    this.#strokes = [];
    this.#current = null;
    this.#redraw();
    this.#onChange(this);
  }

  undo() {
    this.#strokes.pop();
    this.#redraw();
    this.#onChange(this);
  }

  /** 点をいくつか打っただけの「事故サイン」を弾くため、実際に書かれた量で判定する */
  get isEmpty() {
    const total = this.#strokes.reduce((n, s) => n + s.points.length, 0);
    if (total < 8) return true;

    // 描かれた範囲が極端に狭い（＝タップしただけ）ものも空扱いにする
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of this.#strokes) {
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return maxX - minX < 20 * this.#dpr && maxY - minY < 20 * this.#dpr;
  }

  toDataUrl() {
    return this.#canvas.toDataURL('image/png');
  }
}
