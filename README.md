# Forma — Official Releases

Windows builds for the Forma suite. Every artifact on this page is published by the Forma team and verified by SHA-256.

## Products

| Product | Version | What it is |
| --- | --- | --- |
| **Forma Code** | 1.5.6 | Desktop coding workspace based on OpenCode. Ships the Limit Reset engine, account rotation, signed OTA updates and the Forma settings studio. |
| **Forma** | 1.9.3 | Desktop AI workspace based on Qwen with server-verified licensing, MCP connections, skills, mail and signed updates. |
| **Forma Launcher** | 1.9.3 | Central hub that detects, installs, updates and launches Forma and Forma Code from one window. |

## Downloads

- **Forma Code 1.5.6** — [FormaCode-Setup-1.5.6.exe](https://github.com/Forma2Acc/forma/releases/download/forma-code-v1.5.6/FormaCode-Setup-1.5.6.exe)
- **Forma 1.9.3** — [Forma-Setup-1.9.3.exe](https://github.com/Forma2Acc/forma/releases/download/v1.9.3/Forma-Setup-1.9.3.exe)
- **Forma Launcher 1.9.3** — [Forma-Launcher-1.9.3-win64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-launcher-v1.9.3/Forma-Launcher-1.9.3-win64.zip)

## What changed in Forma Code 1.5.6 & Forma 1.9.3

- **Complete rounded GUI redesign (Forma Code 1.5.6):** Eliminated every square corner across the Control Plane, status dock, modals, forms, badges, scrollbars, and License Gate with a unified rounded token scale (`8px`–`22px` & full pills), frosted dark surfaces, hairline translucent borders, and spring micro-transitions.
- **Egress circuit breaker & self-healing failover (Forma Code 1.5.6):** Added per-egress health tracking (consecutive failures, latency EMA, exponential cooldown backoff) across WARP SOCKS5, WARP HTTP, proxy pool nodes, and direct routing — prioritizing low-latency healthy nodes, skipping cooled endpoints, and failing over stalled/refused connections automatically.
- **Automatic app detection & self-healing (Forma 1.9.3):** Discovers installations across Windows 11 MSIX/Store (`Get-AppxPackage`), Uninstall registry (`HKCU`/`HKLM`), Start Menu/Desktop `.lnk` shortcuts, and custom folders — with automatic `winget` install fallback and automatic `%APPDATA%\Forma\updates` cache pruning.
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
