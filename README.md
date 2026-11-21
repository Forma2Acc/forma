# Forma — Official Releases

Windows builds for the Forma suite. Every artifact on this page is published by the Forma team and verified by SHA-256.

## Products

| Product | Version | What it is |
| --- | --- | --- |
| **Forma Code** | 1.4.1 | Desktop coding workspace based on OpenCode. Ships the Limit Reset engine, account rotation, signed OTA updates and the Forma settings studio. |
| **Forma** | 1.8.1 | Desktop AI workspace based on Qwen with server-verified licensing, MCP connections, skills, mail and signed updates. |
| **Forma Launcher** | 1.8.2 | Central hub that detects, installs, updates and launches Forma and Forma Code from one window. |

## Downloads

- **Forma Code 1.4.1** — [FormaCode-Setup-1.4.1.exe](https://github.com/Forma2Acc/forma/releases/download/forma-code-v1.4.1/FormaCode-Setup-1.4.1.exe)
- **Forma 1.8.1** — [Forma-Setup-1.8.1.exe](https://github.com/Forma2Acc/forma/releases/download/v1.8.1/Forma-Setup-1.8.1.exe)
- **Forma Launcher 1.8.2** — [Forma-Launcher-1.8.2-win64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-launcher-v1.8.2/Forma-Launcher-1.8.2-win64.zip)

## What changed in Forma Code 1.4.1

- **Limit Reset is always clickable.** When "Free limit reached" appears, the pill is mounted inside the limit card itself — above every overlay — and automatically floats above the app if anything covers it.
- **Stalled resets cannot lock the button.** A watchdog releases the UI and the engine after a hung run; transient network and Cloudflare errors are retried instead of aborting the whole reset.
- **Automatic account hygiene.** Expired credentials are removed during a reset, healthy accounts rotate automatically, and a spare account is only requested when the cap is real.
- **Restored update pipeline.** Signed OTA checks now resolve against this repository, with SHA-256 verification before install.

## What changed in Forma Launcher 1.8.2

- Update downloads are scoped to the launcher's own audience, so a Forma app release can no longer overwrite the launcher.
- Release feed and download links point at this repository.

## Auto-update and integrity

- Forma Code and Forma verify a signed release manifest before downloading an installer.
- The installer hash is checked against the published SHA-256 before it runs.
- Builds are per-user (`%LOCALAPPDATA%\Programs`) and do not require administrator rights.

## Access keys

Both desktop apps require a valid key at launch. Keys are issued for 10 hours, bound to one PC, and can be obtained from the Forma gateway. Keys are never distributed in this repository.

## Notes

- Windows 10/11, 64-bit.
- The installers are not code-signed, so Windows SmartScreen may ask for confirmation.
