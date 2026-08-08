@echo off
rem ==========================================================================
rem  スマホのカメラを使えるようにする（証明書の作成）
rem
rem  ダブルクリックするだけです。管理者権限は要りません。
rem  終わったら start.bat を起動しなおしてください。
rem
rem  ブラウザは localhost 以外では HTTPS でないとカメラを許可しません。
rem  社内LANの http://192.168.x.x では、どのブラウザでもカメラは動きません。
rem ==========================================================================
setlocal
cd /d "%~dp0"

rem 展開したフォルダ名のまま置かれることが多いので、node-v22... も探す
set "NODE_EXE="
if exist "node\node.exe" set "NODE_EXE=node\node.exe"
if not defined NODE_EXE if exist "node\bin\node.exe" set "NODE_EXE=node\bin\node.exe"
if not defined NODE_EXE (
  for /d %%d in ("node-v*") do (
    if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
  )
)
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo.
  echo   先に setup.bat をダブルクリックしてください。
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" --no-warnings scripts\make-cert.mjs

echo.
pause
