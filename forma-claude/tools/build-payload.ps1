<#
  Build the Forma Claude payload zip.

    powershell -File tools\build-payload.ps1 -Version 2.1.0 `
      -SourceDir "$env:LOCALAPPDATA\Programs\ClaudeForma" `
      -Api https://forma-claude-production.up.railway.app

  Output
    dist\FormaClaude-<version>-win-x64.zip
    dist\FormaClaude-<version>-win-x64.zip.sha256
    dist\release.json          ready for tools/publish-release.mjs

  The payload is the patched Claude Desktop tree. It must already contain the
  forma-reset bundle, so run `node patch.cjs --dest <dir>` first.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [string]$Api = "https://forma-claude-production.up.railway.app",
  [string]$Out = "dist",
  [string]$Notes = "",
  [switch]$SkipKey
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "Version must look like 2.1.0 (got '$Version')"
}
if (-not (Test-Path $SourceDir)) { throw "Source not found: $SourceDir" }
if (-not (Test-Path (Join-Path $SourceDir "claude.exe"))) {
  throw "No claude.exe in $SourceDir. Run patch.cjs against that install first."
}
$asar = Join-Path $SourceDir "resources\app.asar"
if (-not (Test-Path $asar)) { throw "No resources\app.asar in $SourceDir" }

$outDir = Join-Path (Get-Location) $Out
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$stage = Join-Path $env:TEMP ("forma-payload-" + [guid]::NewGuid().ToString("N"))

Write-Host "  staging payload…"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Copy the app, skipping the previous bundle backup and anything the user owns.
$robocopyArgs = @(
  $SourceDir, $stage, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np",
  "/XF", "app.asar.bak", "*.forma-backup"
)
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

# The running app rewrites these; never ship them.
foreach ($rel in @("resources\app.asar.bak")) {
  $p = Join-Path $stage $rel
  if (Test-Path $p) { Remove-Item $p -Force }
}

Set-Content -Path (Join-Path $stage "version") -Value $Version -NoNewline -Encoding ASCII

# Pin the license public key so the client never trusts a fetched key on first run.
if (-not $SkipKey) {
  try {
    Write-Host "  pinning license public key…"
    $pk = Invoke-RestMethod -Uri "$($Api.TrimEnd('/'))/v1/public-key" -UseBasicParsing
    if (-not $pk.publicKey) { throw "no publicKey in the response" }
    Set-Content -Path (Join-Path $stage "forma-public.pem") -Value $pk.publicKey -NoNewline -Encoding ASCII
  } catch {
    throw "Could not fetch the license public key from $Api : $($_.Exception.Message)"
  }
}

$name = "FormaClaude-$Version-win-x64.zip"
$zip = Join-Path $outDir $name
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host "  compressing…"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal -Force
Remove-Item -Path $stage -Recurse -Force -ErrorAction SilentlyContinue

$hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $zip).Length
Set-Content -Path "$zip.sha256" -Value "$hash  $name" -Encoding ASCII

$manifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  asset     = $name
  sha256    = $hash
  size      = $size
  builtAt   = (Get-Date).ToUniversalTime().ToString("o")
  api       = $Api
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $outDir "release.json") -Encoding UTF8

Write-Host ""
Write-Host "  built $name" -ForegroundColor Green
Write-Host "  size   $([math]::Round($size / 1MB, 1)) MB"
Write-Host "  sha256 $hash"
Write-Host ""
Write-Host "  publish:"
Write-Host "    `$env:FORMA_ADMIN_PASSWORD = '<password>'"
Write-Host "    node tools/publish-release.mjs --file $zip --version $Version --api $Api --notes `"$Notes`""
Write-Host ""
