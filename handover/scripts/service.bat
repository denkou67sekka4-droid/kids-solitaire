@echo off
rem 自動起動（タスクスケジューラ）から呼ばれる入口。
rem 設定は start.bat の1か所にまとめてあるので、ここでは
rem 「人が見ていない起動である」ことだけを伝えて start.bat に渡す。
set "HANDOVER_SERVICE=1"
call "%~dp0..\start.bat"
