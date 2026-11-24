# Forma — Official Releases

Windows builds for the Forma suite. Every artifact on this page is published by the Forma team and verified by SHA-256.

## Products

| Product | Version | What it is |
| --- | --- | --- |
| **Forma Code** | 1.5.5 | Desktop coding workspace based on OpenCode. Ships the Limit Reset engine, account rotation, signed OTA updates and the Forma settings studio. |
| **Forma** | 1.9.2 | Desktop AI workspace based on Qwen with server-verified licensing, MCP connections, skills, mail and signed updates. |
| **Forma Launcher** | 1.9.2 | Central hub that detects, installs, updates and launches Forma and Forma Code from one window. |

## Downloads

- **Forma Code 1.5.5** — [FormaCode-Setup-1.5.5.exe](https://github.com/Forma2Acc/forma/releases/download/forma-code-v1.5.5/FormaCode-Setup-1.5.5.exe)
- **Forma 1.9.2** — [Forma-Setup-1.9.2.exe](https://github.com/Forma2Acc/forma/releases/download/v1.9.2/Forma-Setup-1.9.2.exe)
- **Forma Launcher 1.9.2** — [Forma-Launcher-1.9.2-win64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-launcher-v1.9.2/Forma-Launcher-1.9.2-win64.zip)

## What changed in Forma Code 1.5.5 & Forma 1.9.2

- **Deterministic WARP & proxy egress (Forma Code 1.5.5):** Fixed Cloudflare WARP SOCKS5 vs HTTP `CONNECT` negotiation on `127.0.0.1:40000`, added port-bind readiness polling, RFC 1929 SOCKS5 + HTTP `Proxy-Authorization` support, fast `--connect-timeout` probing, and clean socket teardown in `stopTraffic()`.
- **Reliable limit reset & license checks (Forma Code 1.5.5):** Added port-release waits between OpenCode service stop/start, guarded `probeOnce()` and failover against transient timeouts, fixed clock-skew false `security-blocked` states, and hardened Windows atomic file writes.
- **Automatic app detection & self-healing (Forma 1.9.2):** Discovers installations across Windows 11 MSIX/Store (`Get-AppxPackage`), Uninstall registry (`HKCU`/`HKLM`), Start Menu/Desktop `.lnk` shortcuts, and custom folders — with automatic `winget` install fallback and automatic `%APPDATA%\Forma\updates` cache pruning.
- **Rebuilt 2-ad Get-Key websites:** Dedicated minimalist animated pages for each product (`/get-key`, `/get-key/code`, `/get-key/claude`) with kinetic Forma `F.` background animation, strict 2-ad Linkvertise checkpoint meter, and cookie-less server recovery.

## Auto-update and integrity

- Forma Code and Forma verify a signed release manifest before downloading an installer.
- The installer hash is checked against the published SHA-256 before it runs.
- Builds are per-user (`%LOCALAPPDATA%\Programs`) and do not require administrator rights.

## Access keys

Both desktop apps require a valid key at launch. Keys are issued for 10 hours, bound to one PC, and can be obtained from the Forma gateway. Keys are never distributed in this repository.

## Notes

- Windows 10/11, 64-bit.
- The installers are not code-signed, so Windows SmartScreen may ask for confirmation.
