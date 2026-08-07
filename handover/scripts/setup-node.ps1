# ==========================================================================
#  Node.js を自動で用意する
#
#  インストーラは使わない（管理者権限が要らず、PCの設定も変えないため）。
#  公式の zip 版を落として、このフォルダの node\ に展開するだけ。
#  やめたくなったら node\ フォルダを消せば元通り。
# ==========================================================================

$ErrorActionPreference = 'Stop'
$MinVersion = [version]'22.5.0'   # 組込みSQLiteが使えるのがこのバージョンから

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodeDir = Join-Path $root 'node'

Write-Host ''
Write-Host '  荷物引渡し管理 — 初回準備' -ForegroundColor Cyan
Write-Host '  ================================'
Write-Host ''

# すでに用意できているなら何もしない
if (Test-Path (Join-Path $nodeDir 'node.exe')) {
  $v = & (Join-Path $nodeDir 'node.exe') --version
  Write-Host "  Node.js は用意済みです（$v）" -ForegroundColor Green
  Write-Host ''
  Write-Host '  start.bat をダブルクリックすると起動します。'
  Write-Host ''
  exit 0
}

# PCに既に入っている場合もそのまま使える
$installed = Get-Command node -ErrorAction SilentlyContinue
if ($installed) {
  $v = & node --version
  if ([version]($v.TrimStart('v')) -ge $MinVersion) {
    Write-Host "  このPCには既に Node.js が入っています（$v）" -ForegroundColor Green
    Write-Host ''
    Write-Host '  そのまま start.bat をダブルクリックすれば起動します。'
    Write-Host ''
    exit 0
  }
  Write-Host "  入っている Node.js が古いため（$v）、新しいものを用意します。" -ForegroundColor Yellow
}

# 32bit環境は考慮しない（Windows 10以降はほぼ64bit）
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

Write-Host '  最新版を調べています...'

$version = $null
try {
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  # index.json は新しい順。LTS かつ必要バージョン以上の先頭を採る
  foreach ($entry in $index) {
    if (-not $entry.lts) { continue }
    if ([version]($entry.version.TrimStart('v')) -ge $MinVersion) {
      $version = $entry.version
      break
    }
  }
} catch {
  Write-Host '  一覧を取得できませんでした。既定のバージョンで進めます。' -ForegroundColor Yellow
}

if (-not $version) { $version = 'v22.20.0' }

$fileName = "node-$version-win-$arch"
$url = "https://nodejs.org/dist/$version/$fileName.zip"
$zip = Join-Path $env:TEMP "$fileName.zip"
$work = Join-Path $env:TEMP "handover-node-$([guid]::NewGuid().ToString('N'))"

Write-Host "  Node.js $version をダウンロードします（約30MB）..."
Write-Host "  $url"
Write-Host ''

try {
  # 既定の進捗表示があると極端に遅くなることがあるので切る
  $prev = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 600 -UseBasicParsing
  $ProgressPreference = $prev
} catch {
  Write-Host ''
  Write-Host '  ダウンロードできませんでした。' -ForegroundColor Red
  Write-Host "  理由: $($_.Exception.Message)"
  Write-Host ''
  Write-Host '  ── 手作業で用意する場合 ──'
  Write-Host '  1) ブラウザで次のURLを開いてファイルを保存'
  Write-Host "       $url"
  Write-Host '  2) 保存した zip を右クリック →［すべて展開］'
  Write-Host "  3) 出てきた $fileName フォルダを、このフォルダに移動"
  Write-Host "       $root"
  Write-Host '  4) フォルダ名を node に変更（そのままでも動きます）'
  Write-Host ''
  Write-Host '  ※ 社内ネットワークの制限で落とせない場合は、'
  Write-Host '     情報システム部門にご相談ください。'
  Write-Host ''
  exit 1
}

Write-Host '  展開しています...'
try {
  Expand-Archive -Path $zip -DestinationPath $work -Force

  # zip の中は node-vXX-win-x64\ という1階層になっている。
  # 中身をそのまま node\ という名前に置き換える。
  $extracted = Join-Path $work $fileName
  if (-not (Test-Path $extracted)) {
    $extracted = (Get-ChildItem -Path $work -Directory | Select-Object -First 1).FullName
  }

  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item -Path $extracted -Destination $nodeDir
} finally {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path $exe)) {
  Write-Host '  展開に失敗しました。node.exe が見つかりません。' -ForegroundColor Red
  exit 1
}

$got = & $exe --version
Write-Host ''
Write-Host "  準備ができました（Node.js $got）" -ForegroundColor Green
Write-Host ''
Write-Host '  次にやること:' -ForegroundColor Cyan
Write-Host '    start.bat をダブルクリックしてください。'
Write-Host '    黒い画面が出てブラウザが開けば起動しています。'
Write-Host ''
Write-Host '    初回だけ管理者パスワードが表示されます。'
Write-Host '    一度しか出ないので、必ず控えてください。'
Write-Host ''
