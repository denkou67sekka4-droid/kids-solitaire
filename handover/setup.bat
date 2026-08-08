@echo off
rem ==========================================================================
rem  荷物引渡し管理 - 初回準備
rem
rem  アプリを動かすのに必要な Node.js を用意します。
rem  ダブルクリックするだけです。管理者権限は要りません。
rem
rem  Windows 10 以降に標準で入っている curl と tar だけを使います
rem  （PowerShell は使いません）。
rem ==========================================================================
setlocal
cd /d "%~dp0"

set "NODE_VER=v22.20.0"
set "NODE_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=arm64"
set "NODE_PKG=node-%NODE_VER%-win-%NODE_ARCH%"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_PKG%.zip"

echo.
echo   荷物引渡し管理 - 初回準備
echo   ==============================
echo.

rem --- すでに用意できていないか確認する -----------------------------------
if exist "node\node.exe" (
  echo   Node.js は用意済みです。
  echo.
  echo   start.bat をダブルクリックすると起動します。
  goto :end
)

for /d %%d in ("node-v*") do (
  if exist "%%d\node.exe" (
    echo   Node.js を見つけました ^(%%d^)
    echo.
    echo   start.bat をダブルクリックすると起動します。
    goto :end
  )
)

where node >nul 2>nul
if not errorlevel 1 (
  echo   このPCには既に Node.js が入っています。
  echo.
  echo   start.bat をダブルクリックすると起動します。
  goto :end
)

rem --- 必要な道具があるか確認する -----------------------------------------
where curl >nul 2>nul
if errorlevel 1 goto :notools
where tar >nul 2>nul
if errorlevel 1 goto :notools

rem --- ダウンロードして展開する -------------------------------------------
echo   Node.js %NODE_VER% をダウンロードします（約30MB）
echo   %NODE_URL%
echo.

curl -L --fail --progress-bar -o "%TEMP%\%NODE_PKG%.zip" "%NODE_URL%"
if errorlevel 1 goto :dlfail

echo.
echo   展開しています...

if exist "%TEMP%\handover_node" rmdir /s /q "%TEMP%\handover_node"
mkdir "%TEMP%\handover_node"
tar -xf "%TEMP%\%NODE_PKG%.zip" -C "%TEMP%\handover_node"
if errorlevel 1 goto :dlfail

move "%TEMP%\handover_node\%NODE_PKG%" "node" >nul
rmdir /s /q "%TEMP%\handover_node" 2>nul
del "%TEMP%\%NODE_PKG%.zip" 2>nul

if not exist "node\node.exe" goto :dlfail

for /f "delims=" %%v in ('"node\node.exe" --version') do set "GOT=%%v"
echo.
echo   準備ができました（Node.js %GOT%）
echo.
echo   次にやること:
echo     start.bat をダブルクリックしてください。
echo     黒い画面が出てブラウザが開けば起動しています。
echo.
echo     初回だけ管理者パスワードが表示されます。
echo     一度しか出ないので、必ず控えてください。
goto :end

rem --- うまくいかなかったとき ---------------------------------------------
:notools
echo   このパソコンには curl または tar が入っていません。
echo   （Windows 10 の古い版か、Windows 8 以前の可能性があります）
echo.
goto :manual

:dlfail
echo.
echo   ダウンロードまたは展開に失敗しました。
echo   社内ネットワークの制限で止められている可能性があります。
echo.
goto :manual

:manual
echo   ── 手作業で用意する場合 ──
echo.
echo   1^) ブラウザで次のURLを開き、ファイルを保存してください
echo        %NODE_URL%
echo.
echo   2^) 保存した zip を右クリック →［すべて展開］
echo.
echo   3^) 出てきた %NODE_PKG% フォルダを、このフォルダに移動してください
echo        %~dp0
echo.
echo   フォルダ名はそのままで構いません。
echo.

:end
echo.
pause
