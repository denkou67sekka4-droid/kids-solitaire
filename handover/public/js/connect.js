import { api, esc, mountAppBar } from './app.js';

await mountAppBar({ title: 'スマホ・他のPCをつなぐ', back: '/' });

const content = document.getElementById('content');
const { secure, urls, httpUrls, caAvailable, certMissing } = await api('/api/connect');

if (!urls.length) {
  content.innerHTML = `
    <div class="note danger">
      <strong>社内LANのアドレスが見つかりません</strong>
      このPCがネットワークにつながっていない可能性があります。
      有線LANまたはWi-Fiに接続してから、もう一度開いてください。
    </div>`;
} else {
  content.innerHTML = `
    ${certMissing?.length ? `
      <div class="note danger">
        <strong>証明書を作り直してください</strong>
        このPCのアドレス（<b>${esc(certMissing.join(', '))}</b>）が証明書に入っていません。<br>
        ネットワークが変わったか、社内でIPが変わった可能性があります。<br>
        <b>このままではスマホでカメラが使えません。</b><br>
        事務PCで <b>make-cert.bat</b> をダブルクリックし、<b>start.bat</b> を起動しなおしてください。
      </div>` : ''}

    ${secure ? '' : `
      <div class="note warn">
        <strong>いまのままではカメラが使えません</strong>
        ブラウザは、HTTPSでない接続ではカメラを許可しません（このPC自身を除く）。<br>
        事務PCで <b>make-cert.bat</b> をダブルクリックしたあと、
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
      <h2>他の事務PCからつなぐ</h2>
      <p style="margin-top:0">
        他のPCは<b>ブラウザで下のアドレスを開くだけ</b>です。
        インストール作業も、このフォルダをコピーする必要もありません。
      </p>
      ${httpUrls.map((u) => `<div class="url" style="font-size:19px">${esc(u)}</div>`).join('')}
      <p class="hint">
        ${httpUrls.length > 1
          ? '上のコンピュータ名のほうを使ってください。社内でIPが変わってもブックマークが切れません。<br>'
          : ''}
        開いたら<b>ブックマークに入れて</b>おくと、次から一発で開けます。<br>
        カメラは使わないので、証明書の準備は要りません（警告も出ません）。
      </p>

      <div class="note info" style="margin-top:14px">
        <strong>使う人ごとにアカウントを作ってください</strong>
        引渡票には発行した人の名前が刷り込まれ、履歴にも誰がやったかが残ります。
        1つのアカウントを共有すると追えなくなります。<br>
        <a href="/users">［担当者の管理］</a>から追加できます（管理者のみ）。
      </div>

      <p class="hint">
        ※ このPC（サーバ役）を起動しておく必要があります。
        スリープすると他のPCからつながらなくなるので、電源設定を［なし］にしてください。
      </p>
    </div>

    <div class="card">
      <h2>毎回の確認をなくす（任意）</h2>
      <p style="margin-top:0">
        このままでも使えますが、アプリを開くたびに
        <b>証明書の警告</b>と<b>カメラの許可</b>を毎回タップすることになります。<br>
        <span class="hint">
          信用されていない証明書での接続では、Chromeがカメラの許可を覚えてくれないためです。
        </span>
      </p>
      <p class="hint">
        <b>急ぐ場合は飛ばして構いません。</b>タップが増えるだけで、機能は変わりません。
      </p>

      <details style="margin-top:14px">
        <summary style="cursor:pointer;font-weight:700;padding:8px 0">
          方法A：Chromeの設定だけで済ませる（かんたん・2分）
        </summary>
        <p class="hint">
          証明書を入れる代わりに、このアドレスだけをChromeの例外に登録します。
          スマホの［設定］を触らずに済むぶん、こちらのほうが簡単です。
        </p>
        <ol class="steps-num">
          <li>スマホのChromeで <b>chrome://flags</b> を開く（アドレス欄に直接入力）</li>
          <li>検索欄に <b>insecure origins</b> と入力</li>
          <li>［Insecure origins treated as secure］の入力欄に、下のアドレスを入れる</li>
          <li>右のプルダウンを <b>Enabled</b> にする</li>
          <li>画面下の［<b>Relaunch</b>］を押す</li>
          <li>そのアドレスをChromeで開く（<b>https ではなく http</b> です）</li>
        </ol>
        ${httpUrls.map((u) => `<div class="url" style="font-size:17px">${esc(u)}</div>`).join('')}
        <p class="hint">
          この方法では通信が暗号化されません。社内LANの中だけで使う前提の割り切りです。
          社外から使う予定があるときは、方法Bにしてください。
        </p>
      </details>

      ${caAvailable ? `
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-weight:700;padding:8px 0">
          方法B：証明書をスマホに入れる（3分・こちらが本筋）
        </summary>
        <p class="hint">
          <b>スマホでこの画面を開いてから</b>行ってください（PCで押しても意味がありません）。
        </p>
        <ol class="steps-num">
          <li>下のボタンを押して証明書をダウンロード</li>
          <li>スマホの［設定］を開き、<b>検索欄に「証明書」</b>と入力</li>
          <li>［証明書をインストール］または［暗号化と認証情報］を選ぶ</li>
          <li><b>［CA証明書］</b>を選ぶ（［VPNとアプリ］ではありません）</li>
          <li>警告画面が出たら［とにかくインストールする］</li>
          <li>ダウンロードした <b>handover-ca.crt</b> を選ぶ</li>
          <li>Chromeを開きなおす</li>
        </ol>
        <p class="hint">
          メニューの名前は機種によって違います。［設定］の検索を使うのが確実です。
        </p>
        <div class="actions">
          <a class="btn primary" href="/ca.crt" download="handover-ca.crt">証明書をダウンロード</a>
        </div>
      </details>` : ''}
    </div>

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

      <div class="note info" style="margin-top:16px">
        <strong>引取場所で電波が届くか調べる</strong>
        「ときどき止まる」は一度開いただけでは分かりません。
        スマホで下の画面を開き、実際の引取場所まで持っていって30秒ほど置いてください。
      </div>
      <div class="actions">
        <a class="btn primary" href="/check">電波チェックを開く</a>
      </div>
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
