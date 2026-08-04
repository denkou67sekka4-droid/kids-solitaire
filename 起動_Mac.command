#!/bin/bash
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 kanki_intel.py serve
fi
echo "Python 3 が見つかりません。https://www.python.org/ からインストールしてください。"
read -r -p "Enterキーで閉じます..."
