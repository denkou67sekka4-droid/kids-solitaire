#!/usr/bin/env bash
# スマホのカメラを使うための自己署名証明書を作る。
#
# なぜ要るのか:
#   ブラウザは localhost 以外では HTTPS でないとカメラを許可しない。
#   社内LANの http://192.168.x.x では getUserMedia が必ず失敗する。
#
# SAN(subjectAltName) に社内LANのIPを入れておかないと Android Chrome が
# 証明書を受け付けないため、実際のIPを自動で拾って埋め込んでいる。
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$CERT_DIR"

# このマシンが持っているIPv4アドレスを全部集める
IPS=$(
  { ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' \
    || ifconfig 2>/dev/null | grep -oE 'inet (addr:)?([0-9]+\.){3}[0-9]+' | grep -oE '([0-9]+\.){3}[0-9]+'; } \
  | sort -u
)

ALT="DNS:localhost,IP:127.0.0.1"
for ip in $IPS; do
  [ "$ip" = "127.0.0.1" ] && continue
  ALT="$ALT,IP:$ip"
done

# 追加で名前やIPを足したいとき: EXTRA_SAN="DNS:handover.local,IP:10.0.0.5" npm run cert
if [ -n "${EXTRA_SAN:-}" ]; then
  ALT="$ALT,$EXTRA_SAN"
fi

echo "証明書に含めるアドレス: $ALT"

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/server.key" \
  -out    "$CERT_DIR/server.crt" \
  -days 825 \
  -subj "/CN=荷物引渡し管理/O=Handover QR" \
  -addext "subjectAltName=$ALT" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

chmod 600 "$CERT_DIR/server.key"

cat <<EOS

証明書を作成しました:
  $CERT_DIR/server.crt
  $CERT_DIR/server.key

次に:
  1) npm start でサーバを起動しなおす（HTTPSが有効になります）
  2) スマホのChromeで https://<このPCのIP>:8443 を開く
  3) 「接続はプライベートではありません」→［詳細設定］→［...にアクセスする］
     で進むとカメラが使えます。

  毎回の警告が煩わしい場合は server.crt をスマホに転送し、
  Android の［設定］→［セキュリティ］→［暗号化と認証情報］→
  ［ストレージからインストール］→［CA証明書］で入れておくと警告が消えます。

EOS
