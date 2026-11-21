# Forma — Official Releases

Windows builds for the Forma suite. Every artifact on this page is published by the Forma team and verified by SHA-256.

## Products

| Product | Version | What it is |
| --- | --- | --- |
| **Forma Code** | 1.5.1 | Desktop coding workspace based on OpenCode. Ships the Limit Reset engine, account rotation, signed OTA updates and the Forma settings studio. |
| **Forma** | 1.8.1 | Desktop AI workspace based on Qwen with server-verified licensing, MCP connections, skills, mail and signed updates. |
| **Forma Launcher** | 1.8.2 | Central hub that detects, installs, updates and launches Forma and Forma Code from one window. |

## Downloads

- **Forma Code 1.5.1** — [FormaCode-Setup-1.5.1.exe](https://github.com/Forma2Acc/forma/releases/download/forma-code-v1.5.1/FormaCode-Setup-1.5.1.exe)
- **Forma 1.8.1** — [Forma-Setup-1.8.1.exe](https://github.com/Forma2Acc/forma/releases/download/v1.8.1/Forma-Setup-1.8.1.exe)
- **Forma Launcher 1.8.2** — [Forma-Launcher-1.8.2-win64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-launcher-v1.8.2/Forma-Launcher-1.8.2-win64.zip)

## What changed in Forma Code 1.5.1

- **Account-first reset.** A free cap belongs to the account, not the IP. Limit Reset switches to a spare account and verifies it with a real model call in seconds — no workspace restart.
- **Capped accounts are kept.** They stay in the pool as spares. Only expired tokens and duplicate sign-in rows are cleaned, so a reset can no longer delete its own reserves.
- **One card per account.** Repeated sign-ins create several credential rows for the same account; the settings studio collapses them into a single entry with a sign-in count.
- **Honest countdown.** When every account is capped, the panel shows when the cap actually ends and keeps Add Account one click away. Auto-retry arms itself for that moment.
- **Reliable cap detection.** The workspace reports a 429 as HTTP 502 with a `rate_limit` payload; both are recognised, so a real cap is never mistaken for a network error.
- **No pointless IP rotation.** If every account carries the same hours-long cap, the reset skips egress rotation instead of restarting the workspace for nothing.
- **Faster sweeps.** Two independent free models agreeing on the cap end the probe instead of six requests per account.
- **Mid-session recovery.** When the scanner sees the free-limit response during normal work, it switches to a fresh account automatically.
- **Always clickable Reset.** The pill stays mounted inside the "Free limit reached" card, above every overlay, and a stalled run can never lock the button.
- **Automatic updates.** Signed OTA checks run every 30 minutes and install silently; the GitHub release page is only a fallback.

## Auto-update and integrity

- Forma Code and Forma verify a signed release manifest before downloading an installer.
- The installer hash is checked against the published SHA-256 before it runs.
- Builds are per-user (`%LOCALAPPDATA%\Programs`) and do not require administrator rights.

## Access keys

Both desktop apps require a valid key at launch. Keys are issued for 10 hours, bound to one PC, and can be obtained from the Forma gateway. Keys are never distributed in this repository.

## Notes

- Windows 10/11, 64-bit.
- The installers are not code-signed, so Windows SmartScreen may ask for confirmation.
