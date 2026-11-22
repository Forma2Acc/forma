# Forma

Forma is a Windows desktop suite: the **Forma Launcher**, **Forma** (Qwen-based
workspace) and **Forma Code**. The launcher detects, installs, verifies and
updates each app from signed releases.

## Downloads

| What | Link |
| --- | --- |
| Forma Launcher 1.9.0 (includes Forma + Qwen integration) | [Forma-Setup-1.9.0.exe](https://github.com/Forma2Acc/forma/releases/latest/download/Forma-Setup-1.9.0.exe) |
| Latest release notes | [v1.9.0](https://github.com/Forma2Acc/forma/releases/tag/v1.9.0) |
| Forma Code | [forma-code-v1.5.2](https://github.com/Forma2Acc/forma/releases/tag/forma-code-v1.5.2) |
| Forma Claude payload | [forma-claude-production.up.railway.app/download](https://forma-claude-production.up.railway.app/download) |
| Forma Claude key | [forma-claude-production.up.railway.app/get-key](https://forma-claude-production.up.railway.app/get-key) |

Every Windows build is signed with Ed25519 and checked against its SHA-256
before it runs. The launcher keeps a backup and rolls back if an update fails
to boot three times.

### Forma 1.9.0

- Forma Claude install, update, launch and restore inside the launcher.
- 5-hour rolling keys: each successful check-in slides the window forward, so a
  key stays valid while the app is in use.
- The key page returns an existing live key instead of blocking the user.
- One-click payload download at `/download`.

## Repository layout

```
launcher/                 Forma Launcher source (Electron, v1.9.0)
forma-claude/server/      Key site, license service, checkpoint, admin hub
forma-claude/client/main/ License client, chat archive, UI guard
forma-claude/tools/       Release, verification and Discord tooling
forma-claude/installer/   Standalone PowerShell installer for the payload
```

## Build

The launcher is an Electron app. To package it:

```powershell
node node_modules\electron-builder\cli.js --config builder.json --win nsis --x64 --publish never
```

The release config lives in `forma-claude/build/builder-1.9.0.json` in the
private working tree. The signed payload is built with
`forma-claude/tools/build-payload.ps1` and published with
`forma-claude/tools/publish-release.mjs`.

## Verify

```powershell
node forma-claude/tools/test-checkpoint.mjs
node forma-claude/tools/test-update.mjs
```

## Security

This repository contains no secrets. Server configuration is read from the
environment (`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `CHECKPOINT_SECRET`,
`LINKVERTISE_TOKEN`). License and update private keys stay on the publisher
machine and are never committed.
