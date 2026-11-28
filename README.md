# Forma — Official Releases

Windows builds for the Forma suite. Every artifact on this page is published by the Forma team and verified by SHA-256.

## Products

| Product | Version | What it is |
| --- | --- | --- |
| **Forma Code** | 1.5.10 | Desktop coding workspace based on OpenCode. Ships fast browser OAuth Add Account, direct delete, 10 reset methods, Cloudflare One tunnel fix & signed OTA updates. |
| **Forma Claude** | 2.2.2 | Patched Claude Desktop with sidebar Brain Graph, permanent chat delete tombstones, RunCMD brief summaries, zero-prompt Full Access, and Custom Skills Creator. |
| **Forma** | 1.9.6 | Desktop AI workspace based on Qwen with server-verified licensing, 4-provider Limit Reset email failover, MCP connections, skills, and signed updates. |
| **Forma Launcher** | 1.9.6 | Central auto-updating hub that detects, installs, self-heals, and launches Qwen, Forma Claude, and Forma Code from one window with built-in Tutorials. |

## Downloads

- **Forma Code 1.5.10** — [FormaCode-Setup-1.5.10.exe](https://github.com/Forma2Acc/forma/releases/download/forma-code-v1.5.10/FormaCode-Setup-1.5.10.exe)
- **Forma Claude 2.2.2** — [FormaClaude-2.2.2-win-x64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-claude-v2.2.2/FormaClaude-2.2.2-win-x64.zip)
- **Forma 1.9.6** — [Forma-Setup-1.9.6.exe](https://github.com/Forma2Acc/forma/releases/download/v1.9.6/Forma-Setup-1.9.6.exe)
- **Forma Launcher 1.9.6** — [Forma-Launcher-1.9.6-win64.zip](https://github.com/Forma2Acc/forma/releases/download/forma-launcher-v1.9.6/Forma-Launcher-1.9.6-win64.zip)

## What changed in Forma Code 1.5.10, Forma Claude 2.2.2 & Forma 1.9.6

- **Fast Browser OAuth Add Account & Direct Delete (Forma Code 1.5.10):** Clicking **+ Add Account** opens your browser automatically, copies any device code to your Windows clipboard, polls at `600ms`, and provides a one-click **I confirmed — finish now** button (plus temp-email helper). Account deletion runs directly in one click with idempotent cleanup, alongside **Cloudflare One / Zero Trust** egress routing, **10 cascading reset methods**, and silent DPAPI key restoration.
- **Brain Graph Node Contents, Permanent Delete, RunCMD Summary & Custom Skills (Forma Claude 2.2.2):** Clean sidebar-only **Graph** category with clickable OptiGehirn nodes revealing rich details & live chat previews, permanent `deleted.json` tombstones across Delete & Limit Reset, **RunCMD** anchored above replies with brief closing summaries, zero-prompt **Full Access** execution, and a built-in **Custom Skills Creator**.
- **Self-healing Launcher, Redirect-safe Qwen & Email Failover (Forma 1.9.6 / Launcher 1.9.6):** Range-resuming Launcher auto-updates, Qwen CDN redirect support, 4-provider Limit Reset email failover (`mail.tm` -> `mail.gw` -> `1secmail` -> `guerrillamail`), `self-healer.cjs` blob verification, and in-app interactive **Tutorials**.
- **Rolling key continuity & returning-key gateway:** Every valid validation slides expiry forward server-side; `/get-key`, `/get-key/code`, and `/get-key/claude` immediately return active keys with reveal toggles and live countdowns.

## Auto-update and integrity

- Forma Code and Forma verify a signed release manifest before downloading an installer.
- The installer hash is checked against the published SHA-256 before it runs.
- Builds are per-user (`%LOCALAPPDATA%\Programs`) and do not require administrator rights.

## Access keys

Both desktop apps require a valid key at launch. Keys use a rolling 5-hour active session window, are bound to one PC, and can be obtained from the Forma gateway. Keys are never distributed in this repository.

## Notes

- Windows 10/11, 64-bit.
- The installers are not code-signed, so Windows SmartScreen may ask for confirmation.
