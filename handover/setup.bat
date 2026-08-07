@echo off
rem ==========================================================================
rem  荷物引渡し管理 — 初回準備
rem
rem  アプリを動かすのに必要な Node.js を自動で用意します。
rem  ダブルクリックするだけです。管理者権限は要りません。
rem  終わったら start.bat をダブルクリックしてください。
rem ==========================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-node.ps1"

echo.
pause
