/**
 * カメラでQRを読み取る。
 *
 * 読み取りエンジンは2段構え:
 *   1. BarcodeDetector … Android Chrome が標準で持っている。端末側の実装なので速くて正確。
 *   2. jsQR            … 上が無い環境（iOS Safari など）向けのJS実装。
 *                        250KB あるので、必要になったときだけ読み込む。
 *
 * getUserMedia は「安全なコンテキスト」でしか動かない。
 * localhost 以外の http:// では必ず失敗するので、その場合は理由を明示する。
 */

const JSQR_SRC = '/js/vendor/jsQR.js';

function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSQR_SRC;
    s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR の読み込みに失敗しました')));
    s.onerror = () => reject(new Error('jsQR の読み込みに失敗しました'));
    document.head.appendChild(s);
  });
}

export class QrScanner {
  #video;
  #stream = null;
  #track = null;
  #detector = null;
  #jsqr = null;
  #canvas = null;
  #ctx = null;
  #running = false;
  #rafId = null;
  #onResult;
  #onStatus;

  constructor(video, { onResult, onStatus }) {
    this.#video = video;
    this.#onResult = onResult;
    this.#onStatus = onStatus ?? (() => {});
  }

  get hasTorch() {
    return Boolean(this.#track?.getCapabilities?.().torch);
  }

  async start() {
    if (this.#running) return;

    if (!window.isSecureContext) {
      throw new Error(
        'カメラを使うにはHTTPS接続が必要です。' +
        'https:// のアドレスで開き直してください（引渡番号の手入力は下から行えます）。'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('このブラウザはカメラに対応していません。引渡番号を手入力してください。');
    }

    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' }, // 背面カメラ
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (err) {
      throw new Error(describeCameraError(err));
    }

    this.#track = this.#stream.getVideoTracks()[0] ?? null;
    this.#video.srcObject = this.#stream;
    await this.#video.play();

    await this.#prepareEngine();

    this.#running = true;
    this.#onStatus('QRコードを枠内に写してください');
    this.#loop();
  }

  async #prepareEngine() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          this.#detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return;
        }
      } catch {
        // 端末実装が不完全なことがあるので、その場合は黙って jsQR に降りる
      }
    }
    this.#jsqr = await loadJsQr();
    this.#canvas = document.createElement('canvas');
    this.#ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
  }

  #loop = () => {
    if (!this.#running) return;

    // requestVideoFrameCallback があれば、実際に新しいフレームが来たときだけ処理できる
    const schedule = this.#video.requestVideoFrameCallback
      ? (fn) => this.#video.requestVideoFrameCallback(fn)
      : (fn) => requestAnimationFrame(fn);

    this.#rafId = schedule(async () => {
      if (!this.#running) return;
      try {
        const value = await this.#scanFrame();
        if (value) {
          this.#onResult(value);
          return; // 呼び出し側が stop() するまで、ここで一旦止める
        }
      } catch {
        // 1フレーム分の失敗は無視して次のフレームへ
      }
      this.#loop();
    });
  };

  async #scanFrame() {
    const v = this.#video;
    if (v.readyState < 2 || !v.videoWidth) return null;

    if (this.#detector) {
      const found = await this.#detector.detect(v);
      return found[0]?.rawValue ?? null;
    }

    // jsQR は毎フレーム全画素を走査すると重いので、長辺 640px に縮めてから渡す
    const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    if (this.#canvas.width !== w || this.#canvas.height !== h) {
      this.#canvas.width = w;
      this.#canvas.height = h;
    }
    this.#ctx.drawImage(v, 0, 0, w, h);
    const img = this.#ctx.getImageData(0, 0, w, h);
    const res = this.#jsqr(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    return res?.data ?? null;
  }

  /** 読み取り後に再開する（別のお客様を続けて処理するとき） */
  resume() {
    if (!this.#stream || this.#running) return;
    this.#running = true;
    this.#onStatus('QRコードを枠内に写してください');
    this.#loop();
  }

  pause() {
    this.#running = false;
    if (this.#rafId != null && !this.#video.requestVideoFrameCallback) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  stop() {
    this.pause();
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#track = null;
    this.#video.srcObject = null;
  }

  /** 暗い倉庫でのライト。対応端末のみ。 */
  async setTorch(on) {
    if (!this.hasTorch) return false;
    try {
      await this.#track.applyConstraints({ advanced: [{ torch: on }] });
      return true;
    } catch {
      return false;
    }
  }
}

function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラの使用が許可されていません。ブラウザのアドレスバーの鍵マークから「カメラ」を許可してください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりませんでした。引渡番号を手入力してください。';
    case 'NotReadableError':
      return 'カメラを他のアプリが使用中です。ほかのアプリを閉じてから、もう一度お試しください。';
    default:
      return `カメラを起動できませんでした（${err?.name ?? '原因不明'}）。引渡番号を手入力してください。`;
  }
}
