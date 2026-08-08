import { api, esc, mountAppBar } from './app.js';

await mountAppBar({ title: 'スマホをつなぐ', back: '/' });

const content = document.getElementById('content');
const { secure, urls, httpsPort } = await api('/api/connect');

if (!urls.length) {
  content.innerHTML = `
    <div class="note danger">
      <strong>社内LANのアドレスが見つかりません</strong>
      このPCがネットワークにつながっていない可能性があります。
      有線LANまたはWi-Fiに接続してから、もう一度開いてください。
    </div>`;
} else {
  content.innerHTML = `
    ${secure ? '' : `
      <div class="note warn">
        <strong>いまのままではカメラが使えません</strong>
        ブラウザは、HTTPSでない接続ではカメラを許可しません（このPC自身を除く）。<br>
        <b>scripts\\make-cert.ps1</b> を右クリック →［PowerShell で実行］したあと、
        <b>start.bat</b> を起動しなおしてください。<br>
        ※ このままでも、引渡番号を手で入力しての動作確認はできます。
      </div>`}

    <div class="card">
      <h2>スマホでの開き方</h2>
      <ol class="steps-num">
        <li>スマホを<b>このPCと同じWi-Fi</b>につないでください（モバイル通信では届きません）</li>
        <li>スマホの<b>カメラ</b>を下のQRコードに向けます</li>
        <li>出てきたリンクをタップするとアプリが開きます</li>
        ${secure ? `<li><b>「接続はプライベートではありません」</b>と出たら、
          ［詳細設定］→［...にアクセスする］で進んでください<br>
          <span class="hint">社内用の証明書のため必ず出ます。故障ではありません。</span></li>` : ''}
        <li>ユーザー名とパスワードでログインします</li>
      </ol>
    </div>

    ${urls.map((url, i) => `
      <div class="card">
        <div class="conn">
          <img src="/qr/connect.svg?i=${i}&mm=45" alt="${esc(url)} のQRコード" width="170" height="170">
          <div>
            <div class="url">${esc(url)}</div>
            <p class="hint">
              QRが読めない場合は、スマホのブラウザにこのアドレスを直接入力してください。
            </p>
            ${urls.length > 1 ? `<p class="hint">
              ネットワークが複数あるPCです。つながらない場合は、別のQRもお試しください。
            </p>` : ''}
          </div>
        </div>
      </div>`).join('')}

    <div class="card">
      <h2>つながらないとき</h2>
      <dl class="kv">
        <dt>Wi-Fi</dt>
        <dd>スマホがモバイル通信になっていませんか。PCと同じWi-Fiが必要です。</dd>
        <dt>ゲストWi-Fi</dt>
        <dd>ゲスト用のWi-Fiは、端末どうしの通信が禁止されていることがあります。
            社内用のWi-Fiにつなぎ直してください。</dd>
        <dt>ファイアウォール</dt>
        <dd>このPCで初回に確認が出た際、［プライベートネットワーク］を許可しましたか。
            ブロックしているとスマホから届きません。</dd>
        <dt>スリープ</dt>
        <dd>このPCがスリープしていると、他の端末からはつながりません。</dd>
      </dl>
    </div>

    <div class="card">
      <h2>読み取りの動作確認をする</h2>
      <p style="margin-top:0">
        本番のお客様を待たずに、いまここで確かめられます。
      </p>
      <ol class="steps-num">
        <li>このPCで <a href="/issue">引渡票を発行</a>（お名前は「テスト」、個数は 2 など）</li>
        <li>発行後に出る<b>引渡票の画面をPCに表示したまま</b>にします</li>
        <li>スマホでアプリを開き、［QRを読み取る］→ <b>PCの画面のQRを写します</b></li>
        <li>お客様情報が出たら、PCで［荷物ラベルを印刷］を開き、<b>画面のQRを2枚とも写します</b></li>
        <li>サイン画面が出たら指で書いて、［引渡しを確定する］</li>
      </ol>
      <p class="hint">
        紙に印刷しなくても、PCの画面に映したQRをそのまま読み取れます。<br>
        確認に使った引渡票は、一覧の［詳細］から取消しておくと残りません。
      </p>
    </div>
  `;
}

content.setAttribute('aria-busy', 'false');
