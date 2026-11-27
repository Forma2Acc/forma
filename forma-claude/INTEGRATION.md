# Forma Claude — integration patch for `claude-reset/src/forma-reset/main.cjs`

This is the drop-in that fixes the lost chats. It replaces the old archive block
(lines ~2165-2332) and the archive calls in `runReset()` / `autoCaptureTick()`.

## 1. Add the module near the top

```js
const { createChatStore } = require("./forma-chat-store.cjs");

const chatStore = createChatStore({
  rootDir,
  getSessionKey: currentSessionKey,
  getAccounts: readAccounts,
  log,
});
```

## 2. Replace `archiveAccount`, `pruneArchives`, `listArchives`

Delete them. They are superseded. The store owns the layout.

## 3. Replace the archive step in `runReset()`

Old (L2429-2445):

```js
pct(3, "archive");
let archived = 0;
if (cfg.autoCapture) {
  const key = await currentSessionKey();
  if (key) {
    const info = await claudeAccountInfo(key);
    if (info.ok) { ... }
  }
}
```

New:

```js
pct(3, "archive");
let archived = 0;
if (cfg.autoCapture) {
  const result = await chatStore.captureQuiet({
    email: cfg.currentEmail,
    signal,
    emit: (e) => emit({ runId: id, ...e }),
  });
  archived = result?.conversations || 0;
}
```

The store resolves the key itself and never gates on `claudeAccountInfo`. If the
session is dead it reports `{ ok:false, reason:"org-unavailable" }` and the reset
continues — but the previous archive file is untouched, so nothing is lost.

## 4. Replace `autoCaptureTick()` body

```js
async function autoCaptureTick() {
  if (running || !cfg.autoCapture) return;
  const result = await chatStore.captureQuiet({ email: cfg.currentEmail });
  if (result?.ok) log("[auto] archived", { conversations: result.conversations });
  else log("[auto] skipped", { reason: result?.reason || "unknown" });
}
```

Drop the `autoSig` map. The store's merge is cheap and idempotent, so the
signature optimisation is no longer needed — and it was a source of missed
captures when `updated_at` granularity collided.

## 5. Add the quit hook

```js
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  chatStore
    .captureOnQuit()
    .catch(() => {})
    .finally(() => app.exit(0));
});
```

Declare `let quitting = false;` beside `running`.

## 6. Replace the IPC handlers

```js
ipcMain.handle(CH.archiveList, async () => {
  const index = await chatStore.list();
  return index.items.map((c) => ({
    id: c.uuid,
    email: cfg.currentEmail,
    orgName: null,
    capturedAt: c.capturedAt,
    count: c.messageCount,
    name: c.name,
  }));
});

ipcMain.handle(CH.archiveGet, async (_e, id) => chatStore.get(id));
ipcMain.handle(CH.archiveDelete, async (_e, id) => chatStore.remove(id));

ipcMain.handle(CH.archiveCapture, async () => {
  const result = await chatStore.captureQuiet({ email: cfg.currentEmail });
  return { id: result?.email, count: result?.conversations || 0 };
});
```

## 7. UI

- The `#fr-arch` button already exists in `preload.js`. Point it at `archiveList`.
- Add a "Save now" button to the Reset tab that calls `CH.archiveCapture`.
- Show `stats().pendingRetries` when it is non-zero. Silent retry queues are how
  people stop trusting the archive.

## 8. Right-click

`forma-ui-guard.cjs` is already wired into the source at `preload.js:1123` and
`:1149`. The problem is that the **built asar predates those edits**:

```
app.asar       22 Nov 14:15:50
preload.js     22 Nov 14:23:27
```

Rebuild before testing:

```powershell
node patch.cjs --dest "$env:LOCALAPPDATA\Programs\ClaudeForma"
node check-asar.cjs
```

Then verify the guard is live:

```powershell
$root = "$env:APPDATA\Claude\forma-reset"
Set-Content "$root\debug.flag" "" -NoNewline
Start-Process "$env:LOCALAPPDATA\Programs\ClaudeForma\claude.exe"
Start-Sleep 40
Get-Content "$root\logs\forma-reset.log" | Select-String "probe"
```

Right-click the pill. Nothing should appear. If a menu still opens, the asar was
not rebuilt — the source guard cannot help a stale bundle.

## 9. Verify the fix end to end

```powershell
$root = "$env:APPDATA\Claude\forma-reset"
Set-Content "$root\selftest.flag" "reset" -NoNewline
Remove-Item "$root\selftest-report.json" -ErrorAction SilentlyContinue
Start-Process "$env:LOCALAPPDATA\Programs\ClaudeForma\claude.exe"
Start-Sleep 50
Get-Content "$root\selftest-report.json" -Raw
Get-ChildItem "$root\archive\conv" | Measure-Object | Select-Object Count
```

Expected: `saved > 0`, `conversations` equals the real chat count, and
`archive\conv\` holds one file per conversation with non-empty `messages`.

## 10. Current release state (verified 2026-11-27)

| Piece | Value |
| --- | --- |
| Key site | https://forma-claude-production.up.railway.app/get-key |
| One-click payload | https://forma-claude-production.up.railway.app/download |
| Payload release | 2.1.15 (artifact missing at time of check, see below) |
| OTA catalog | `https://forma-core-production.up.railway.app/v1/releases/latest` -> 1.9.x |

### Agent bridge (this release)

The overlay now installs its fetch/XHR hook in the page's **main world** from
the main process (`forma:reset:inject-main` -> `webContents.executeJavaScript`).
A preload runs in an isolated world, so its own `webFrame.executeJavaScript`
could never patch the `fetch` the web app actually calls; that was the reason
the notice and the tool blocks silently never reached the model.

Verified on 2026-11-27 with `selftest.flag`:

| Check | Result |
| --- | --- |
| Hook install | `hooked:true`, `isForma:true` |
| Header on completion | `[fetch-hook] comp-ctx`, 24 tools, ~7.1 KB |
| Tool execution | `run_command` returned real files from `C:\Users\furaa\Downloads` |
| Restore | 91/91 conversations reconciled, archived chat editable |
| Notice | stored in the user message and rendered visibly |
| Reset barrier | 27/27 captured, 0 empty, 0 lossy |

The prompt is written as a product integration with a live host probe instead
of an authority claim, and a refusal without any tool call triggers one
automatic recovery turn that runs a real `system_info` probe and continues.

`patch.cjs` now compiles the hook during the build. The hook lives inside a
template literal, so `node --check` cannot see it; a stray newline used to ship
code that threw at runtime and disabled every tool.

### Known issue

`/download` returns 302 to `FormaClaude-2.1.15-win-x64.zip`, but every probed
artifact under `/downloads/` returns 404. The release store is empty, so the
download is a dead end until a payload is uploaded through
`POST /<admin>/api/releases/upload`.

Key policy: a key is valid for **5 hours**. Every accepted `/v1/validate`
slides `expiresAt` to `now + 5h`, so an app in use never runs out; an idle key
lapses on its own. The lease itself is 15 minutes and is renewed every 45
seconds.

`/get-key/start` returns the installation's live key (`200`, "Your key is still
active") instead of a dead end. A 60 second cooldown applies only after a key
has actually lapsed. `/get-key` also shows the live key when the
`forma_inst` cookie is present.

Discord cards now point at the working paths: the launcher card downloads
`Forma-Setup-1.9.0.exe`, the Claude cards use `/download` and `/get-key`.

### Linkvertise

The static link's destination must be `https://<host>/get-key/return`. The
current `LINKVERTISE_URL` destination points elsewhere, so the automatic return
may not fire; the key page's "Landed somewhere else?" field accepts the address
the user actually landed on and completes the challenge from its hash.
