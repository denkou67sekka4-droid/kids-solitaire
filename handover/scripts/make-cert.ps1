# ==========================================================================
#  スマホのカメラを使うための自己署名証明書を作る（Windows用）
#
#  ブラウザは localhost 以外では HTTPS でないとカメラを許可しない。
#  社内LANの http://192.168.x.x では getUserMedia が必ず失敗する。
#
#  Windows標準の New-SelfSignedCertificate だけで作るので、
#  OpenSSL のインストールは要らない。管理者権限も不要。
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
foreach ($ip in $ips) { $san += "IPAddress=$ip" }
$sanText = '2.5.29.17={text}' + ($san -join '&')

Write-Host ''
Write-Host '証明書に含めるアドレス:' -ForegroundColor Cyan
foreach ($s in $san) { Write-Host "  $s" }
Write-Host ''

$cert = New-SelfSignedCertificate `
  -Subject 'CN=荷物引渡し管理' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @($sanText, '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
  -NotAfter (Get-Date).AddYears(2)

# PFXの取り出しにはパスワードが要る。使い捨てを生成して隣に置く
# （鍵そのものが入ったファイルなので、certs\ ごと外に出さないこと）
$plain = -join ((1..24) | ForEach-Object { [char](Get-Random -InputObject ([char[]]'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789')) })
$pw = ConvertTo-SecureString -String $plain -Force -AsPlainText

$pfxPath = Join-Path $certDir 'server.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pw | Out-Null
Set-Content -Path (Join-Path $certDir 'server.pfx.pass') -Value $plain -NoNewline -Encoding ascii

# 作った証明書は証明書ストアに残しておく必要がないので消す
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force

# スマホに入れる用（これには秘密鍵が入らないので配っても安全）
$cerPath = Join-Path $certDir 'server.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null

Write-Host '証明書を作成しました:' -ForegroundColor Green
Write-Host "  $pfxPath"
Write-Host ''
Write-Host '次に:'
Write-Host '  1) start.bat でサーバを起動しなおす（HTTPSが有効になります）'
Write-Host '  2) スマホのChromeで https://<このPCのIP>:8443 を開く'
Write-Host '  3) 「接続はプライベートではありません」→［詳細設定］→［...にアクセスする］'
Write-Host ''
Write-Host '  毎回の警告が煩わしい場合は certs\server.cer をスマホに転送し、'
Write-Host '  Androidの［設定］→［セキュリティ］→［暗号化と認証情報］→'
Write-Host '  ［ストレージからインストール］→［CA証明書］で入れておくと警告が消えます。'
Write-Host ''
Write-Host '  ※ certs\ には秘密鍵が入っています。共有フォルダに置かないでください。' -ForegroundColor Yellow
Write-Host ''
