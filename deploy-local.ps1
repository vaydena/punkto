# deploy-local.ps1 - LOKALER Deploy zu Hostinger (FTPS via curl.exe) mit Diagnose + Ausweichwegen.
#
# Wann lokal? Wenn das GitHub-Secret FTP_PASSWORD (noch) nicht stimmt oder es sofort
# live muss. Normalweg bleibt GitHub Actions (.github/workflows/deploy.yml) - der
# Linux-Runner (curl + OpenSSL) laedt auch grosse Dateien sauber hoch.
#
# ⛔ NIE mit hochgeladen (siehe $excludeTop/$excludeName unten):
#    - *.local.txt  (v. a. OPERATOR-KEY.local.txt) — Betreiber-Schluessel nur lokal.
#    - supabase/    (Edge Functions — separat via Supabase).
#    - gen_icons.py, deploy-local.*, README.md, .gitignore, .git/.github.
#
# Lehren (uebernommen aus lagerverwaltung, 2026-09-02):
#  - NIE Login-Wiederholungen (--retry-all-errors) gegen Hostingers FTP: nach einer
#    Serie von Fehl-Logins (530) sperrt der Brute-Force-Schutz die IP (curl 28).
#  - Uploads gebuendelt (6 Dateien je curl-Aufruf = EIN Login, mehrere STOR).
#  - Windows-curl (Schannel) brach frueher beim TLS-Abbau der Datenverbindung ab (ProFTPD: 450 Link lost, Datei verworfen).
#    GELOEST: mit --tlsv1.2 --tls-max 1.2 gingen alle betroffenen Dateien durch
#    (der TLS-1.2-Shutdown-Pfad in Schannel ist sauber). Deshalb ist TLS 1.2 der
#    STANDARD fuer den Paket-Upload; scheitert eine Datei trotzdem, greifen der Reihe
#    nach Ausweich-Transportwege, der erste funktionierende wird beibehalten:
#      S1 curl --tlsv1.2 --tls-max 1.2 (PROT P)        -> Paket-Upload (Standard)
#      S2 curl ohne TLS-Pinning (TLS 1.3)               (frueherer Standard; brach ab)
#      S3 curl --ftp-ssl-control                        (Login TLS, Datenkanal PROT C = klar;
#                                                        Website-Dateien sind ohnehin oeffentlich)
#      S4 .NET FtpWebRequest mit EnableSsl (SslStream)  (anderer TLS-Stack)
#  - Server-Dialog jedes Fehlversuchs landet in deploy-local.log (Passwort maskiert,
#    git-ignoriert) - das Log darf Claude lesen.
#
# Passwort: interaktiv per Read-Host -AsSecureString. Landet NIE in der History,
# NIE im Klartext auf der Platte, wird von Claude nie gesehen.
#
# Aufruf:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\karbi\Documents\Claude Code\punkto-web\deploy-local.ps1"

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$FTPHOST = 'ftp.vaydena.de'
$FTPUSER = 'u424339903.deploy'
$FTPDIR  = 'punkto'
$SITE    = 'https://punkto.vaydena.de'
$curl    = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $curl)) { $curl = 'curl.exe' }   # Fallback ueber PATH
# WICHTIG: in Windows PowerShell 5.1 ist "curl" ein Alias fuer Invoke-WebRequest,
# deshalb IMMER curl.exe explizit aufrufen (via $curl).

$log  = Join-Path $root 'deploy-local.log'
$errf = Join-Path $env:TEMP 'pk-curl-stderr.txt'
Set-Content -Path $log -Value ("deploy-local.log  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8

function Log([string]$m) { Write-Host $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

Log "Ziel : ftp://$FTPHOST/$FTPDIR/"
Log "User : $FTPUSER"
Log ("curl : " + ((& $curl --version | Select-Object -First 1)))
$sec = Read-Host "Hostinger Deploy-FTP Passwort" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pw   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if ([string]::IsNullOrWhiteSpace($pw)) { Log "Kein Passwort eingegeben - Abbruch."; exit 1 }

# curl-Aufruf; Exit-Code landet in $script:rc, stdout wird zurueckgegeben, stderr in $errf.
function Invoke-Ftp([string[]]$extra, [bool]$verbose = $false) {
  $a = @('--ssl-reqd','-k','--connect-timeout','30','--max-time','600',
         '--silent','--show-error','--stderr',$errf,
         '--user',"$($FTPUSER):$pw")
  if ($verbose) { $a += '-v' }
  $a += $extra
  $o = & $curl @a
  $script:rc = $LASTEXITCODE
  return $o
}

# Server-Dialog des letzten curl-Aufrufs (aus $errf) maskiert + gefiltert ins Log.
function Dialog([string]$title) {
  if (-not (Test-Path $errf)) { return }
  $lines = @(Get-Content $errf -ErrorAction SilentlyContinue | ForEach-Object {
    $l = $_ -replace '^(> PASS ).*', '$1***'
    if ($pw) { $l = $l.Replace($pw, '***') }
    $l
  } | Where-Object {
    ($_ -match '^[<>] ' -and $_ -notmatch '^> (TYPE|PBSZ|AUTH|EPSV|PASV|QUIT|PWD)' -and $_ -notmatch '^< (227|229|257|215) ') -or
    ($_ -match '^\* ' -and $_ -match 'fail|Fail|error|Error|timed|abort|Recv|Send|refused|reset|closed|Remote file|curl|Shutdown|TLS|SSL') -or
    ($_ -match '^curl: ')
  })
  Log "    --- Server-Dialog ($title) ---"
  foreach ($l in $lines) { Log "    $l" }
}

function Listing([string]$title) {
  Log ""; Log "== Listing $title (LIST -a) =="
  foreach ($d in @('', 'assets/', 'assets/data/')) {
    Log "-- /$FTPDIR/$d"
    $o = Invoke-Ftp @('-X', 'LIST -a', "ftp://$FTPHOST/$FTPDIR/$d")
    if ($script:rc -ne 0) { Log "   (LIST rc=$($script:rc))"; Dialog "LIST $d" }
    else { foreach ($l in @($o)) { Log "   $l" } }
  }
}

function Rel([System.IO.FileInfo]$f) {
  return (($f.FullName.Substring($root.Length + 1)) -replace '\\','/')
}

# --- .NET-Upload (Strategie S4): anderer TLS-Stack (SslStream statt Schannel-in-curl) ---
try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls13 }
catch { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 }
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }   # Hostinger-Cert lautet *.hstgr.io
function Upload-DotNet([string]$local, [string]$remoteRel) {
  $req = [System.Net.FtpWebRequest]::Create("ftp://$FTPHOST/$FTPDIR/$remoteRel")
  $req.Method      = [System.Net.WebRequestMethods+Ftp]::UploadFile
  $req.Credentials = New-Object System.Net.NetworkCredential($FTPUSER, $pw)
  $req.EnableSsl   = $true
  $req.UseBinary   = $true
  $req.UsePassive  = $true
  $req.KeepAlive   = $false
  $req.Timeout     = 120000
  $req.ReadWriteTimeout = 120000
  $bytes = [System.IO.File]::ReadAllBytes($local)
  $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  $resp = $req.GetResponse(); $desc = $resp.StatusDescription; $resp.Close()
  return $desc
}

# --- 0) Login-Test: EIN Versuch ---
[void](Invoke-Ftp @('--fail', "ftp://$FTPHOST/", '-o', 'NUL'))
if ($script:rc -eq 67) { Log "FTP-Login abgelehnt (530 Login incorrect) - Passwort pruefen. Abbruch OHNE weitere Versuche (sonst IP-Sperre)."; $pw = $null; exit 67 }
if ($script:rc -ne 0)  { Dialog 'Login'; Log "FTP nicht erreichbar (curl $($script:rc)) - Abbruch."; $pw = $null; exit $script:rc }
Log "Login OK."

# --- 1) Listing vorher ---
Listing 'VORHER'

# --- 2) Dateiliste (⛔ *.local.txt / supabase / gen_icons.py NIE deployen) ---
$excludeTop = @('.git', '.github', 'supabase', 'test', 'tools', 'node_modules')
$excludeName = @('deploy-local.ps1', 'deploy-local.log', '.gitignore', 'README.md', 'gen_icons.py')
$allowExt = @('.html', '.js', '.css', '.json', '.png', '.svg', '.webmanifest', '.wasm', '.gz', '.txt', '.ico', '.webp', '.jpg', '.woff2')
$files = @(Get-ChildItem -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1)
  $top = ($rel -split '[\\/]')[0]
  ($excludeTop -notcontains $top) -and ($excludeName -notcontains $_.Name) -and ($_.Name -notlike '*.local.txt') -and
  # Positivliste: nur Web-Dateitypen (schuetzt vor versehentlich liegengebliebenen Notizen, Backups, .env ...)
  (($allowExt -contains $_.Extension.ToLower()) -or ($_.Name -eq '.htaccess'))
})
$total = $files.Count
Log ""; Log ("== Upload: {0} Dateien in Paketen zu 6 (S1 curl TLS 1.2) ==" -f $total)
foreach ($f in $files) { Log ("   + " + (Rel $f)) }

# --- 3) Pakete von 6 Dateien; Ergebnis je Datei ueber -w %{exitcode} ---
$batchSize = 6
$failed = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $total; $i += $batchSize) {
  $end   = [Math]::Min($i + $batchSize, $total) - 1
  $batch = @($files[$i..$end])
  $a = @('--ftp-create-dirs', '--tlsv1.2', '--tls-max', '1.2', '-w', '%{exitcode} %{url}\n')
  foreach ($f in $batch) { $a += @('-T', $f.FullName, "ftp://$FTPHOST/$FTPDIR/$(Rel $f)") }
  $o = Invoke-Ftp $a
  $batchRc = $script:rc
  if ($batchRc -eq 67) { Log "FTP-Login abgelehnt (530) - Abbruch."; $pw = $null; exit 67 }
  $results = @{}
  foreach ($l in @($o)) {
    if ($l -match ('^(\d+) ftp://[^/]+/' + [regex]::Escape($FTPDIR) + '/(.+)$')) { $results[$matches[2]] = [int]$matches[1] }
  }
  foreach ($f in $batch) {
    $rel  = Rel $f
    $code = if ($results.ContainsKey($rel)) { $results[$rel] } else { $batchRc }
    if ($code -eq 0) { Log ("  OK   {0}" -f $rel) }
    else { Log ("  FEHL {0}  (curl {1})" -f $rel, $code); [void]$failed.Add($rel) }
  }
  Start-Sleep -Milliseconds 800
}

# --- 4) Ausweich-Transportwege fuer fehlgeschlagene Dateien ---
$strategies = @(
  @{ Name = 'S2 curl ohne TLS-Pinning'; Args = @('--ssl-reqd') },
  @{ Name = 'S3 curl PROT C (--ftp-ssl-control)'; Args = @('--ftp-ssl-control') },
  @{ Name = 'S4 .NET FtpWebRequest';   Args = $null }
)
$startAt = 0   # Index der zuletzt erfolgreichen Strategie (wird fuer Folgedateien beibehalten)
if ($failed.Count -gt 0) {
  Log ""; Log "== Ausweichwege fuer $($failed.Count) Datei(en) =="
  $still = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $failed) {
    $full = Join-Path $root ($rel -replace '/', '\')
    $tgt  = "ftp://$FTPHOST/$FTPDIR/$rel"
    Log "### $rel"
    $done = $false
    for ($si = $startAt; $si -lt $strategies.Count -and -not $done; $si++) {
      $st = $strategies[$si]
      if ($null -ne $st.Args) {
        $extra = @('--fail', '--ftp-create-dirs') + $st.Args + @('-T', $full, $tgt)
        [void](Invoke-Ftp $extra $true)
        if ($script:rc -eq 0) { Log "  OK   $($st.Name): $rel"; $done = $true; $startAt = $si }
        else {
          Log "  $($st.Name): curl $($script:rc)"; Dialog $st.Name
          if ($script:rc -eq 67) { Log "Login abgelehnt - Abbruch."; $pw = $null; exit 67 }
        }
      } else {
        try {
          $desc = Upload-DotNet $full $rel
          Log "  OK   $($st.Name): $rel  ($($desc.Trim()))"; $done = $true; $startAt = $si
        } catch {
          $msg = $_.Exception.Message
          if ($_.Exception.InnerException) { $msg += ' | ' + $_.Exception.InnerException.Message }
          if ($pw) { $msg = $msg.Replace($pw, '***') }
          Log "  $($st.Name): FEHLER $msg"
        }
      }
      if (-not $done) { Start-Sleep -Seconds 2 }
    }
    if (-not $done) { [void]$still.Add($rel) }
  }
  $failed = $still
}

# --- 5) Listing nachher ---
Listing 'NACHHER'

$pw = $null
[GC]::Collect()

# --- 6) HTTPS-Verify (Textdateien: Groesse vergleichen; Medien: nur HTTP-Code) ---
Log ""; Log "== HTTPS-Verify =="
$textExt = @('.html', '.css', '.js', '.txt', '.md', '.webmanifest', '.json')
$bad = 0
foreach ($f in $files) {
  $rel = Rel $f
  if ($f.Name.StartsWith([string][char]46)) { Log ("  {0,-45} {1}" -f $rel, "uebersprungen (Serverdatei, per HTTPS nicht abrufbar)"); continue }
  $isText = $textExt -contains $f.Extension.ToLower()
  $url = "$SITE/${rel}?cb=$(Get-Random)"
  if ($isText) {
    $o = & $curl -s -o NUL --stderr $errf -w '%{http_code} %{size_download}' $url
    $parts = "$o".Trim().Split(' ')
    $code = $parts[0]; $size = 0; if ($parts.Count -gt 1) { $size = [int64]$parts[1] }
    if ($code -ne '200') { $state = "FEHLT (HTTP $code)" }
    elseif ($size -ne $f.Length) { $state = "ABWEICHUNG lokal=$($f.Length) live=$size" }
    else { $state = 'ok' }
  } else {
    $o = & $curl -s -I -o NUL --stderr $errf -w '%{http_code}' $url
    $code = "$o".Trim()
    $state = if ($code -eq '200') { 'ok' } else { "FEHLT (HTTP $code)" }
  }
  if ($state -ne 'ok') { $bad++ }
  Log ("  {0,-45} {1}" -f $rel, $state)
}
$o = & $curl -s --stderr $errf "$SITE/index.html?cb=$(Get-Random)"
$title = ([regex]::Match("$o", '<title>([^<]*)</title>')).Groups[1].Value
Log "  Startseiten-Titel live: $title"

Log ""
if ($failed.Count -gt 0) {
  Log "FEHLGESCHLAGEN ($($failed.Count)):"
  foreach ($r in $failed) { Log "   - $r" }
}
if ($bad -gt 0 -or $failed.Count -gt 0) {
  Log "Verify: $bad Datei(en) fehlen/abweichend. Log fuer Claude: $log"
  exit 1
}
Log "FERTIG - alle $total Dateien live. Log: $log"
