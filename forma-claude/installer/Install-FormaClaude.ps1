<#
  Forma Claude — installer.

  Two payload shapes are supported:

    app.asar only     patches an existing Claude Desktop install in place.
                      This is the normal download. It keeps the user's own
                      Claude version and only swaps the app bundle, after
                      backing up the original.

    full app folder   installs a complete copy to %LOCALAPPDATA%\Programs\FormaClaude.

  From a download (checksum is mandatory):
    powershell -ExecutionPolicy Bypass -File Install-FormaClaude.ps1 `
      -Url https://<host>/downloads/FormaClaude-2.1.0.zip -Sha256 <64 hex>

  From a local file:
    powershell -ExecutionPolicy Bypass -File Install-FormaClaude.ps1 -Source .\FormaClaude-2.1.0.zip
#>
[CmdletBinding()]
param(
  [string]$Source = "",
  [string]$Url = "",
  [string]$Sha256 = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\FormaClaude",
  [string]$Version = "",
  [switch]$NoShortcuts,
  [switch]$Silent
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Say($msg, $kind = "info") {
  if ($Silent) { return }
  switch ($kind) {
    "ok"   { Write-Host "  $msg" -ForegroundColor Green }
    "warn" { Write-Host "  $msg" -ForegroundColor Yellow }
    "bad"  { Write-Host "  $msg" -ForegroundColor Red }
    default { Write-Host "  $msg" }
  }
}

function Fail($msg) {
  Write-Host ""
  Write-Host "  Forma Claude could not be installed." -ForegroundColor Red
  Write-Host "  $msg" -ForegroundColor Red
  Write-Host ""
  exit 1
}

function Find-Claude {
  $candidates = @()
  $base = Join-Path $env:LOCALAPPDATA "AnthropicClaude"
  if (Test-Path $base) {
    $candidates += Get-ChildItem -Path $base -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "resources\app.asar" }
  }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\ClaudeForma\resources\app.asar"),
    (Join-Path $env:LOCALAPPDATA "Programs\Claude\resources\app.asar"),
    (Join-Path ${env:ProgramFiles} "Claude\resources\app.asar")
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) { return (Get-Item $path) }
  }
  return $null
}

Write-Host ""
Write-Host "  Forma Claude" -ForegroundColor White
Write-Host "  Limit Reset for Claude Desktop, with chat archiving." -ForegroundColor DarkGray
Write-Host ""

# ── resolve the payload ──────────────────────────────────────────────────────
$temp = Join-Path $env:TEMP ("forma-claude-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
  $payload = $null

  if ($Url) {
    if (-not $Sha256) { Fail "A remote install needs -Sha256. Refusing to run an unverified download." }
    if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail "-Sha256 must be 64 hex characters." }
    $payload = Join-Path $temp "payload.zip"
    Say "downloading…"
    try {
      Invoke-WebRequest -Uri $Url -OutFile $payload -UseBasicParsing -MaximumRedirection 5
    } catch {
      Fail "Download failed: $($_.Exception.Message)"
    }
    Say "verifying checksum…"
    $actual = (Get-FileHash -Path $payload -Algorithm SHA256).Hash
    if ($actual -ne $Sha256.ToUpperInvariant()) {
      Fail "Checksum mismatch.`n  expected $($Sha256.ToUpperInvariant())`n  actual   $actual"
    }
    Say "checksum ok" "ok"
  } elseif ($Source) {
    if (-not (Test-Path $Source)) { Fail "Not found: $Source" }
    $payload = (Get-Item $Source).FullName
  } else {
    Fail "Pass -Url with -Sha256, or -Source with a local payload."
  }

  $expanded = $null
  if ((Get-Item $payload).PSIsContainer) {
    $expanded = (Get-Item $payload).FullName
  } else {
    $expanded = Join-Path $temp "payload"
    New-Item -ItemType Directory -Path $expanded -Force | Out-Null
    Say "extracting…"
    try {
      Expand-Archive -Path $payload -DestinationPath $expanded -Force
    } catch {
      Fail "The payload is not a valid archive: $($_.Exception.Message)"
    }
  }

  # ── patch an existing install (app.asar payload) ───────────────────────────
  $asar = Get-ChildItem -Path $expanded -Filter "app.asar" -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($asar) {
    $target = Find-Claude
    if (-not $target) {
      Fail "Claude Desktop was not found. Install Claude from claude.ai first, then run this again."
    }

    Say "found Claude at $($target.FullName)"
    $running = Get-Process -Name "claude" -ErrorAction SilentlyContinue
    if ($running) {
      Say "closing Claude…" "warn"
      $running | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 1200
    }

    $backup = $target.FullName + ".forma-backup"
    if (-not (Test-Path $backup)) {
      Say "backing up the original bundle…"
      Copy-Item -Path $target.FullName -Destination $backup -Force
    }

    Say "installing Forma Claude…"
    Copy-Item -Path $asar.FullName -Destination $target.FullName -Force

    $exe = Join-Path (Split-Path (Split-Path $target.FullName -Parent) -Parent) "claude.exe"
    if (-not (Test-Path $exe)) {
      $exe = (Get-ChildItem -Path (Split-Path (Split-Path $target.FullName -Parent) -Parent) -Filter "claude.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
    }

    if (-not $NoShortcuts -and $exe) {
      $shell = New-Object -ComObject WScript.Shell
      foreach ($lnk in @(
        (Join-Path ([Environment]::GetFolderPath("Programs")) "Forma Claude.lnk"),
        (Join-Path ([Environment]::GetFolderPath("Desktop")) "Forma Claude.lnk")
      )) {
        try {
          $s = $shell.CreateShortcut($lnk)
          $s.TargetPath = $exe
          $s.WorkingDirectory = Split-Path $exe -Parent
          $s.IconLocation = "$exe,0"
          $s.Description = "Forma Claude"
          $s.Save()
        } catch {}
      }
    }

    # A tiny uninstaller that puts the original bundle back.
    $uninstall = Join-Path $env:LOCALAPPDATA "Uninstall-FormaClaude.ps1"
    @"
`$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name 'claude' | Stop-Process -Force
Start-Sleep -Milliseconds 800
if (Test-Path '$backup') { Copy-Item -Path '$backup' -Destination '$($target.FullName)' -Force }
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'Forma Claude.lnk') -Force
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Forma Claude.lnk') -Force
Write-Host 'Forma Claude removed. The original Claude bundle is back.'
"@ | Set-Content -Path $uninstall -Encoding UTF8

    $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FormaClaude"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "DisplayName" -Value "Forma Claude"
    Set-ItemProperty -Path $key -Name "DisplayVersion" -Value ($(if ($Version) { $Version } else { "2.1.0" }))
    Set-ItemProperty -Path $key -Name "Publisher" -Value "Forma"
    Set-ItemProperty -Path $key -Name "InstallLocation" -Value (Split-Path $target.FullName -Parent)
    Set-ItemProperty -Path $key -Name "NoModify" -Value 1 -Type DWord
    Set-ItemProperty -Path $key -Name "NoRepair" -Value 1 -Type DWord
    Set-ItemProperty -Path $key -Name "UninstallString" -Value "powershell -ExecutionPolicy Bypass -File `"$uninstall`""

    Say "installed" "ok"
    Write-Host ""
    Write-Host "  Launch Claude from the Start menu." -ForegroundColor White
    Write-Host "  It asks for a key on first start." -ForegroundColor DarkGray
    Write-Host ""

    if (-not $Silent -and $exe) {
      $answer = Read-Host "  Launch now? [Y/n]"
      if ($answer -eq "" -or $answer -match '^[Yy]') {
        Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent)
      }
    }
    exit 0
  }

  # ── install a complete copy (full app payload) ─────────────────────────────
  $exe = Get-ChildItem -Path $expanded -Filter "claude.exe" -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $exe) { Fail "The payload has neither app.asar nor claude.exe." }

  $running = Get-Process -Name "claude" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$InstallDir*" }
  if ($running) {
    Say "closing the running app…" "warn"
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }

  if (Test-Path $InstallDir) {
    Say "removing the previous version…"
    Remove-Item -Path $InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  Say "installing to $InstallDir…"
  $root = $exe.Directory.FullName
  Copy-Item -Path (Join-Path $root "*") -Destination $InstallDir -Recurse -Force

  if (-not $Version) {
    $vf = Join-Path $InstallDir "version"
    if (Test-Path $vf) { $Version = (Get-Content $vf -Raw).Trim() }
  }
  if (-not $Version) { $Version = "2.1.0" }

  if (-not $NoShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($lnk in @(
      (Join-Path ([Environment]::GetFolderPath("Programs")) "Forma Claude.lnk"),
      (Join-Path ([Environment]::GetFolderPath("Desktop")) "Forma Claude.lnk")
    )) {
      try {
        $s = $shell.CreateShortcut($lnk)
        $s.TargetPath = Join-Path $InstallDir "claude.exe"
        $s.WorkingDirectory = $InstallDir
        $s.IconLocation = (Join-Path $InstallDir "claude.exe") + ",0"
        $s.Description = "Forma Claude"
        $s.Save()
      } catch {}
    }
  }

  $uninstall = Join-Path $InstallDir "Uninstall-FormaClaude.ps1"
  @"
`$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name 'claude' | Where-Object { `$_.Path -like '$InstallDir*' } | Stop-Process -Force
Start-Sleep -Milliseconds 600
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'Forma Claude.lnk') -Force
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Forma Claude.lnk') -Force
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FormaClaude' -Recurse -Force
Remove-Item -Path '$InstallDir' -Recurse -Force
"@ | Set-Content -Path $uninstall -Encoding UTF8

  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FormaClaude"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "DisplayName" -Value "Forma Claude"
  Set-ItemProperty -Path $key -Name "DisplayVersion" -Value $Version
  Set-ItemProperty -Path $key -Name "Publisher" -Value "Forma"
  Set-ItemProperty -Path $key -Name "InstallLocation" -Value $InstallDir
  Set-ItemProperty -Path $key -Name "DisplayIcon" -Value (Join-Path $InstallDir "claude.exe")
  Set-ItemProperty -Path $key -Name "NoModify" -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name "NoRepair" -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name "UninstallString" `
    -Value "powershell -ExecutionPolicy Bypass -File `"$uninstall`""

  Say "installed $Version" "ok"
  Write-Host ""
  Write-Host "  Launch Forma Claude from the Start menu." -ForegroundColor White
  Write-Host "  First run asks for your key." -ForegroundColor DarkGray
  Write-Host ""

  if (-not $Silent) {
    $answer = Read-Host "  Launch now? [Y/n]"
    if ($answer -eq "" -or $answer -match '^[Yy]') {
      Start-Process -FilePath (Join-Path $InstallDir "claude.exe") -WorkingDirectory $InstallDir
    }
  }
} finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
