#!/usr/bin/env bash
# スマホのカメラを使うための証明書を作る。
#
# なぜ要るのか:
#   ブラウザは localhost 以外では HTTPS でないとカメラを許可しない。
#   社内LANの http://192.168.x.x では getUserMedia が必ず失敗する。
#
# なぜ2枚作るのか:
#   自己署名の証明書を1枚だけ作ってスマホに入れても、警告は消えない。
#   Androidが「認証局(CA)の証明書」として受け入れるには CA:TRUE が要り、
#   サーバ用の証明書は CA:FALSE でなければならない。両立しないので分ける。
#     ca.crt     … 社内用の認証局。スマホに入れる（秘密鍵を含まないので配ってよい）
#     server.crt … サーバが名乗る証明書。ca.crt で署名する
#
#   警告が出たまま「アクセスする」で進んでも使えるが、
#   証明書が信用されていない接続ではカメラの許可が記憶されず、
#   毎回聞かれることになる。ca.crt を入れておけばそれも解消する。
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$CERT_DIR"

# このマシンが持っているIPv4アドレスを集める。
# ip / ifconfig は環境によって無いので、アプリの動作に必須な node から取る。
# こうしておくと、サーバ起動時に表示されるURLと証明書の中身が必ず一致する。
IPS=$(node -e '
  const nets = require("node:os").networkInterfaces();
  const addrs = Object.values(nets).flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  console.log([...new Set(addrs)].join("\n"));
' 2>/dev/null || true)

ALT="DNS:localhost,IP:127.0.0.1"

# ホスト名も入れておく。社内DHCPでIPが変わっても
# http://ホスト名:8080 で開けるようにしておくと、貼り替えの手間が減る
HOST=$(hostname 2>/dev/null || true)
if [ -n "$HOST" ] && [ "$HOST" != "localhost" ]; then
  ALT="$ALT,DNS:$HOST,DNS:$HOST.local"
fi

for ip in $IPS; do
  [ "$ip" = "127.0.0.1" ] && continue
  ALT="$ALT,IP:$ip"
done

# 追加で名前やIPを足したいとき: EXTRA_SAN="DNS:handover.local,IP:10.0.0.5" npm run cert
if [ -n "${EXTRA_SAN:-}" ]; then
  ALT="$ALT,$EXTRA_SAN"
fi

echo "証明書に含めるアドレス: $ALT"

# --- 1. 社内用の認証局（スマホに入れる方） --------------------------------
openssl req -x509 -nodes -newkey rsa:2048 -utf8 \
  -keyout "$CERT_DIR/ca.key" \
  -out    "$CERT_DIR/ca.crt" \
  -days 3650 \
  -subj "/CN=荷物引渡し管理 社内CA/O=Handover QR" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  2>/dev/null

# --- 2. サーバ用の証明書（認証局で署名する） ------------------------------
openssl req -nodes -newkey rsa:2048 -utf8 \
  -keyout "$CERT_DIR/server.key" \
  -out    "$CERT_DIR/server.csr" \
  -subj "/CN=荷物引渡し管理/O=Handover QR" \
  2>/dev/null

openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
  -out "$CERT_DIR/server-leaf.crt" \
  -days 825 \
  -extfile <(printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$ALT") \
  2>/dev/null

# ブラウザに認証局まで届くよう、サーバが返す証明書は2枚つなげておく
cat "$CERT_DIR/server-leaf.crt" "$CERT_DIR/ca.crt" > "$CERT_DIR/server.crt"

rm -f "$CERT_DIR/server.csr" "$CERT_DIR/server-leaf.crt" "$CERT_DIR/ca.srl"
chmod 600 "$CERT_DIR/server.key" "$CERT_DIR/ca.key"

cat <<EOS

証明書を作成しました:
  $CERT_DIR/server.crt   サーバ用（自動で読み込まれます）
  $CERT_DIR/ca.crt       スマホに入れる用

次に:
  1) npm start でサーバを起動しなおす（HTTPSが有効になります）
  2) 事務PCで［スマホをつなぐ］を開き、QRをスマホで読み取る
  3) 最初は警告が出るので［詳細設定］→［...にアクセスする］で進む
  4) ログイン後、［スマホをつなぐ］の案内に従って ca.crt をスマホに入れる
     → 以降は警告が出なくなり、カメラの許可も毎回聞かれなくなります

  ※ certs/ には秘密鍵が入っています。共有フォルダに置かないでください。
     配ってよいのは ca.crt だけです。

EOS
