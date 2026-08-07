@echo off
rem ==========================================================================
rem  荷物引渡し管理 — 起動用
rem
rem  このファイルをダブルクリックするとサーバが起動します。
rem  黒い画面を閉じるとサーバも止まります（お仕事の終わりに閉じてください）。
rem
rem  Node.js のインストールは不要です。
rem  https://nodejs.org/ja/download から「Windows Binary (.zip)」を落として
rem  展開し、中身をこのフォルダの node\ に置けば動きます。
rem  （管理者権限もインストーラも要りません）
rem ==========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ---- ここを自社に合わせて書き換えてください ----
set "HANDOVER_ORG_NAME=荷物引渡し窓口"
set "PORT=8080"
set "HTTPS_PORT=8443"
rem ------------------------------------------------

set "NODE_EXE="
if exist "node\node.exe" set "NODE_EXE=node\node.exe"
if not defined NODE_EXE if exist "node\bin\node.exe" set "NODE_EXE=node\bin\node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo.
  echo   Node.js が見つかりませんでした。
  echo.
  echo   https://nodejs.org/ja/download から
  echo   「Windows Binary (.zip)」を落として展開し、
  echo   中身をこのフォルダの node\ に置いてください。
  echo.
  echo     %~dp0node\node.exe
  echo.
  echo   ↑ この場所に node.exe があればOKです。
  echo.
  pause
  exit /b 1
)

rem HANDOVER_SERVICE は autostart.ps1 から自動起動されたときに立つ。
rem そのときは人が見ていないので、ブラウザを開いたり入力待ちで止まったりしない。
if defined HANDOVER_SERVICE goto :run

echo.
echo   荷物引渡し管理を起動します...
echo   （この画面を閉じると停止します）
echo.

rem 起動が済んだころにブラウザを開く
start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%/"

:run
"%NODE_EXE%" --no-warnings src\server.js

if defined HANDOVER_SERVICE exit /b %errorlevel%

echo.
echo   サーバが停止しました。
pause
