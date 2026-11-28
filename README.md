# Forma — Official Releases

Windows builds for the Forma suite. Every artifact on this page is published by the Forma team and verified by SHA-256.

## Products

| Product | Version | What it is |
| --- | --- | --- |
| **Forma Code** | 1.5.9 | Desktop coding workspace based on OpenCode. Ships the Limit Reset engine, account rotation, signed OTA updates and the Forma settings studio. |
| **Forma** | 1.9.5 | Desktop AI workspace based on Qwen with server-verified licensing, MCP connections, skills, mail and signed updates. |
| **Forma Launcher** | 1.9.5 | Central hub that detects, installs, updates and launches Forma and Forma Code from one window. |

## Downloads

- **Forma Code 1.5.9** — [FormaCode-Setup-1.5.9.exe](https://github.com/Forma2Acc/forma/releases/download/forma-code-v1.5.9/FormaCode-Setup-1.5.9.exe)
- **Forma 1.9.5** — [Forma-Setup-1.9.5.exe](https://github.com/Forma2Acc/forma/releases/download/v1.9.5/Forma-Setup-1.9.5.exe)
- **Forma Launcher 1.9.5** — [Forma-Launcher-1.9.5-win64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-launcher-v1.9.5/Forma-Launcher-1.9.5-win64.zip)

## What changed in Forma Code 1.5.9 & Forma 1.9.5

- **Silent DPAPI key restoration & `revoked` UI (Forma Code 1.5.9):** Restores your DPAPI-sealed key silently at boot (`shouldShowGate()`, hard 5-second boot cap, 24-hour offline grace), supports `FORMA1.` key reload, and exposes clear `revoked` handling with **"Use a different key"** and **"Sign out"** controls.
- **Self-healing payload engine (Forma 1.9.5):** `self-healer.cjs` verifies Ed25519-signed `forma-manifest.json` (`FORMA-MANIFEST-v1\n`), caches verified blobs at `%LOCALAPPDATA%\Forma\cache\blobs\<sha256>`, repairs corrupt/missing payload files in place with zero installer download, rolls back A/B generations on failed `--forma-selftest`, and logs to `%APPDATA%\Forma\logs\heal.log`.
- **Rolling 5-hour key continuity & returning-key gateway:** Every valid `/v1/validate` slides `expiresAt` forward server-side; `/get-key`, `/get-key/code`, and `/get-key/claude` immediately return your active key with reveal toggle and countdown instead of a cooldown wall.
- **Obsidian code formatting & egress failover (Forma Code 1.5.9):** Deep obsidian (`#0b0b0f`) rounded `14px` code blocks, fully rounded GUI (`0` square corners), and per-egress circuit-breaker failover across WARP & proxy pool nodes.

## Auto-update and integrity

- Forma Code and Forma verify a signed release manifest before downloading an installer.
- The installer hash is checked against the published SHA-256 before it runs.
- Builds are per-user (`%LOCALAPPDATA%\Programs`) and do not require administrator rights.

## Access keys

Both desktop apps require a valid key at launch. Keys use a rolling 5-hour active session window, are bound to one PC, and can be obtained from the Forma gateway. Keys are never distributed in this repository.

## Notes

- Windows 10/11, 64-bit.
- The installers are not code-signed, so Windows SmartScreen may ask for confirmation.
