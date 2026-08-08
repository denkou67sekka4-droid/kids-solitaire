# ==========================================================================
#  サーバを「PCの起動と同時に」立ち上げるよう登録する（Windows用）
#
#  なぜ要るのか:
#    start.bat を手で動かす運用だと、電源が入っていても止まることがある。
#      ・Windows Update が夜中に再起動する → 黒い画面ごと消える
#      ・担当者がサインアウトする          → そのユーザーのプロセスは終了する
#      ・うっかり黒い画面を閉じる
#    どれも「PCは動いているのにアプリだけ死んでいる」状態になり、
#    お客様が来てから気づくことになる。
#
#    タスクスケジューラに SYSTEM 権限・起動時トリガで登録しておくと、
#    再起動してもサインアウトしても自動で立ち上がり直す。
#    異常終了しても自動で再起動する。
#
#  使い方（初回だけ管理者権限が要ります）:
#    スタートメニューで「PowerShell」を右クリック →［管理者として実行］
#    cd <このフォルダ>
#    powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#
#  やめるとき:
#    powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove
# ==========================================================================
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'HandoverQR'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serviceBat = Join-Path $root 'scripts\service.bat'

# 管理者権限があるか
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host ''
  Write-Host '  管理者権限が必要です。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  スタートメニューで「PowerShell」を右クリック →［管理者として実行］'
  Write-Host '  してから、もう一度実行してください。'
  Write-Host ''
  Write-Host '  ── 管理者権限が使えない場合 ──'
  Write-Host '  スタートアップに入れる方法でも、再起動には追従できます。'
  Write-Host '  （ただしサインアウトすると止まります）'
  Write-Host ''
  Write-Host '    1) Win+R で shell:startup と入力'
  Write-Host '    2) 開いたフォルダに start.bat のショートカットを置く'
  Write-Host ''
  exit 1
}

# --- 解除 ---------------------------------------------------------------
if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ''
    Write-Host '  自動起動を解除しました。' -ForegroundColor Green
    Write-Host '  以降は start.bat をダブルクリックして使ってください。'
    Write-Host ''
  } else {
    Write-Host '  自動起動は登録されていません。'
  }
  exit 0
}

# --- 登録 ---------------------------------------------------------------
if (-not (Test-Path $serviceBat)) {
  throw "起動用ファイルが見つかりません: $serviceBat"
}

$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"$serviceBat`"" -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM で動かす。サインインしていなくても動き、サインアウトでも止まらない。
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description '荷物引渡し管理サーバ（PC起動時に自動で立ち上がります）' | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host '  自動起動を登録しました。' -ForegroundColor Green
Write-Host ''
Write-Host '  これで次のときも自動で立ち上がります:'
Write-Host '    ・PCを再起動したとき（Windows Update の再起動を含む）'
Write-Host '    ・担当者がサインアウトしたとき'
Write-Host '    ・アプリが異常終了したとき（1分後に再起動します）'
Write-Host ''
Write-Host '  動いているかの確認:' -ForegroundColor Cyan
Write-Host '    ブラウザで  http://localhost:8080/health  を開く'
Write-Host '    （他のPCからは http://<このPC名>:8080/health ）'
Write-Host ''
Write-Host '  ※ start.bat を手で動かす必要はもうありません。'
Write-Host '     二重に起動しないよう、黒い画面が出ていたら閉じてください。'
Write-Host ''
Write-Host '  ※ スリープは別途 [設定]→[システム]→[電源] で［なし］にしてください。'
Write-Host '     自動起動を登録しても、スリープ中は他のPCからつながりません。'
Write-Host ''
