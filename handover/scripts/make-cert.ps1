# ==========================================================================
#  スマホのカメラを使うための証明書を作る（Windows用）
#
#  なぜ要るのか:
#    ブラウザは localhost 以外では HTTPS でないとカメラを許可しない。
#    社内LANの http://192.168.x.x では getUserMedia が必ず失敗する。
#
#  なぜ2枚作るのか:
#    自己署名の証明書を1枚だけ作ってスマホに入れても、警告は消えない。
#    Androidが「認証局(CA)の証明書」として受け入れるには CA:TRUE が要り、
#    サーバ用の証明書は CA:FALSE でなければならない。両立しないので分ける。
#      ca.crt     … 社内用の認証局。スマホに入れる（秘密鍵を含まないので配ってよい）
#      server.pfx … サーバが名乗る証明書。ca.crt で署名する
#
#    警告が出たまま「アクセスする」で進んでも使えるが、
#    証明書が信用されていない接続ではカメラの許可が記憶されず、
#    毎回聞かれることになる。ca.crt を入れておけばそれも解消する。
#
#  Windows標準の機能だけで作るので、OpenSSL のインストールは要らない。
#  管理者権限も不要。
#
#  使い方: このファイルを右クリック →［PowerShell で実行］
#          または  powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1
# ==========================================================================

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$certDir = Join-Path $root 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

# このPCが持っているIPv4アドレスを集める
$ips = Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
       Select-Object -ExpandProperty IPAddress -Unique

# SAN(subjectAltName)を組み立てる。
# IPで接続する場合、ブラウザは DNS= ではなく IPAddress= のエントリしか見ないため、
# 実際のIPを IPAddress= として入れておかないと証明書が拒否される。
$san = @('DNS=localhost', 'IPAddress=127.0.0.1')

# コンピュータ名も入れておく。社内DHCPでIPが変わっても
# http://PC名:8080 で開けるようにしておくと、貼り替えの手間が減る
$san += "DNS=$env:COMPUTERNAME"
$san += "DNS=$env:COMPUTERNAME.local"

foreach ($ip in $ips) { $san += "IPAddress=$ip" }
$sanText = '2.5.29.17={text}' + ($san -join '&')

Write-Host ''
Write-Host '証明書に含めるアドレス:' -ForegroundColor Cyan
foreach ($s in $san) { Write-Host "  $s" }
Write-Host ''

# --- 1. 社内用の認証局（スマホに入れる方） --------------------------------
$ca = New-SelfSignedCertificate `
  -Subject 'CN=荷物引渡し管理 社内CA, O=Handover QR' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 `
  -KeyUsage CertSign, CRLSign `
  -TextExtension @('2.5.29.19={critical}{text}CA=true&pathlength=0') `
  -NotAfter (Get-Date).AddYears(10)

# --- 2. サーバ用の証明書（認証局で署名する） ------------------------------
$server = New-SelfSignedCertificate `
  -Subject 'CN=荷物引渡し管理, O=Handover QR' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -Signer $ca `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @(
    $sanText,
    '2.5.29.37={text}1.3.6.1.5.5.7.3.1',
    '2.5.29.19={critical}{text}CA=false'
  ) `
  -NotAfter (Get-Date).AddYears(2)

# --- 3. 書き出す ----------------------------------------------------------

# PFXの取り出しにはパスワードが要る。使い捨てを生成して隣に置く
# （鍵そのものが入ったファイルなので、certs\ ごと外に出さないこと）
$plain = -join ((1..24) | ForEach-Object { [char](Get-Random -InputObject ([char[]]'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789')) })
$pw = ConvertTo-SecureString -String $plain -Force -AsPlainText

$pfxPath = Join-Path $certDir 'server.pfx'
# ブラウザに認証局まで届くよう、連鎖ごと書き出す
Export-PfxCertificate -Cert $server -FilePath $pfxPath -Password $pw -ChainOption BuildChain | Out-Null
Set-Content -Path (Join-Path $certDir 'server.pfx.pass') -Value $plain -NoNewline -Encoding ascii

# スマホに入れる用。秘密鍵は含まれないので配ってよい。
# アプリから配信するため、Linux/macOS版と同じ PEM 形式で揃える。
$caPem = "-----BEGIN CERTIFICATE-----`n" +
         ([Convert]::ToBase64String($ca.RawData, 'InsertLineBreaks')) +
         "`n-----END CERTIFICATE-----`n"
Set-Content -Path (Join-Path $certDir 'ca.crt') -Value $caPem -NoNewline -Encoding ascii

# 証明書ストアに残しておく必要はないので消す
Remove-Item -Path ("Cert:\CurrentUser\My\" + $server.Thumbprint) -Force
Remove-Item -Path ("Cert:\CurrentUser\My\" + $ca.Thumbprint) -Force

Write-Host '証明書を作成しました:' -ForegroundColor Green
Write-Host "  $pfxPath   サーバ用（自動で読み込まれます）"
Write-Host "  $(Join-Path $certDir 'ca.crt')       スマホに入れる用"
Write-Host ''
Write-Host '次に:'
Write-Host '  1) start.bat でサーバを起動しなおす（HTTPSが有効になります）'
Write-Host '  2) 事務PCで［スマホをつなぐ］を開き、QRをスマホで読み取る'
Write-Host '  3) 最初は警告が出るので［詳細設定］→［...にアクセスする］で進む'
Write-Host '  4) ログイン後、［スマホをつなぐ］の案内に従って証明書をスマホに入れる'
Write-Host '     → 以降は警告が出なくなり、カメラの許可も毎回聞かれなくなります'
Write-Host ''
Write-Host '  ※ certs\ には秘密鍵が入っています。共有フォルダに置かないでください。' -ForegroundColor Yellow
Write-Host '     配ってよいのは ca.crt だけです。'
Write-Host ''
