@echo off
chcp 65001 > nul
cd /d "%~dp0"

py -3 --version >nul 2>nul
if %errorlevel% equ 0 (
    py -3 kanki_intel.py serve
    goto :eof
)

python --version >nul 2>nul
if %errorlevel% equ 0 (
    python kanki_intel.py serve
    goto :eof
)

echo Python 3 が見つかりません。
echo https://www.python.org/downloads/ からインストールしてください。
echo インストール時に「Add Python to PATH」にチェックを入れてください。
pause
