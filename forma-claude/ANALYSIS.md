# Forma Claude — analysis and build plan

Read from the live tree on 22 Nov 2026. Every claim below is tied to a file and a line.

---

## 1. What exists, and how each piece actually works

### 1.1 Forma Code (`forma-code/client/main/forma-reset.cjs`, 1404 lines)

This is the **control plane**, not a chat store. It does five things:

| Concern | Mechanism | Evidence |
|---|---|---|
| Egress | loopback HTTP/CONNECT proxy (`127.0.0.1:40001`) in front of a SOCKS5/HTTP upstream or WARP | `startTraffic()` L539, `openUpstream()` L191 |
| Rotation | proxy pool + WARP re-registration (`registration delete` → `registration new`) | `rotateWarp()` L493 |
| Burn ledger | IPs and accounts marked burned, 45 min / 10 min TTL | `markIp()` L437, `LEDGER_TTL_MS` L27 |
| Quota detection | real model probe via `/api/experimental/generate`, plus plaintext body sniff `free usage limit` | `sweepQuota()` L1006, `probeOnce()` L990 |
| Account switching | `/api/credential/:id/activate` | `activateAccount()` L923 |

**It never archives a conversation.** There is no chat read, no chat write, no archive path anywhere in the file. Qwen/OpenCode chats live server-side in the OpenCode backend; the launcher only rotates credentials.

That is the first hard fact: **the Qwen lane and the Claude lane solve different halves.** Qwen rotates access. Claude must *also* preserve the transcript, because a Claude account cannot read another account's chats.

### 1.2 claude-reset (`claude-reset/src/forma-reset/main.cjs`)

This one *does* archive. `archiveAccount()` L2193. And it is where the chats are being lost.

### 1.3 The four ways a chat disappears today

**Bug A — archive is skipped when the account is unhealthy.**
`runReset()` L2431-2445:

```js
if (cfg.autoCapture) {
  const key = await currentSessionKey();
  if (key) {
    const info = await claudeAccountInfo(key);   // ← gate
    if (info.ok) { ... archiveAccount(...) }     // ← archive only here
  }
}
```

`claudeAccountInfo` hits `/api/organizations` (L1099). If the sessionKey is stale, the cookie was rotated, or the network blipped, `info.ok` is false and **nothing is archived**. The reset then proceeds and the account is overwritten. Chats gone, no error surfaced, one `[auto] skipped` log line at most.

**Bug B — only 800 conversations, offset 0, never paginated.**
L2199: `?limit=800&offset=0`. No follow-up page. Past 800 chats, the rest are invisible and get dropped on merge.

**Bug C — one rate-limit kills a whole conversation, silently.**
L2236: `catch { /* one bad conversation does not fail the archive */ }`. No retry, no backoff. A 429 on conversation 37 means conversation 37 is not in the archive and will never be re-fetched once the account switches.

**Bug D — no capture at quit.**
`autoCaptureTick` runs at `45 s` then every `4 min` (L2409-2417). There is no `before-quit` handler. Close the app inside that window and the last messages are lost. There is also no "Save now" button.

**Bug E — text extraction drops structured content.**
`messageText()` L2181 only reads `m.text`, `m.content[]` text blocks, or a string `content`. Tool-use blocks, images, thinking blocks are dropped. A tool-heavy chat can archive as near-empty.

**Bug F — merge can discard a newer version.**
L2279-2283 keeps `old` when `updatedAt` is not newer *and* `messages.length` is smaller. Two edits inside the same timestamp granularity silently keep the stale copy.

**Bug G — the archive file is written once, at the end.**
L2293. A crash mid-archive leaves the previous file untouched — which is *safe* but also means a long archive that dies at 90 % saves nothing.

---

## 2. What the rebuild does about each

| Bug | Fix |
|---|---|
| A | Archive is decoupled from account health. Key resolution falls back through live cookie → accounts.json → last-known. Org resolution falls back to the cached `orgId`. A failed org fetch reuses the last snapshot instead of skipping. |
| B | Full pagination until an empty page, capped by a byte budget not a count. |
| C | Per-conversation retry, 3 attempts, exponential backoff, 429-aware. Failures are recorded in `_failures` and retried on the next tick. |
| D | `before-quit` capture with a 6 s hard timeout, plus a "Save now" IPC and a 90 s tick while the window is focused. |
| E | Full content walker: text, thinking, tool_use, tool_result, image (as a placeholder with mime + byte length), plus a `raw` fallback. |
| F | Monotonic merge: union of message hashes, ordered by timestamp then original index. Nothing is ever removed. |
| G | Per-conversation sidecar files, then an index. A crash keeps every conversation already written. |

Plus: atomic writes (`tmp` → rename), a lock so two captures cannot race, and a `_meta` block on every file recording source, attempts and failures.

---

## 3. Licensing: what is actually achievable

Olivia asked for "server-side, impossible to crack, obfuscated, hidden."

Honest engineering answer, stated once:

- **Key issuance, verification, feature computation and revocation live server-side.** The client holds only a public key. Forging a key requires the private key. That part is genuinely strong.
- **The client is an Electron app. Anyone with the machine can patch its JavaScript.** No client-side scheme is uncrackable. The correct goal is *tamper cost*, not impossibility: casual patching detected, revocation working, valuable logic never shipped to the client.
- **Obfuscation is tamper-resistance, not secrecy.** It raises the cost of reading the protected module. It does not make it unreadable.

Design that follows from this:

1. The launcher ships a **thin signed shell**. All gated logic lives in a protected module that is **encrypted at rest** and **decrypted only after a valid lease is returned by the server**.
2. The lease is short-lived (15 min), device-bound, and revocable. A patched client that skips the check still has no decryption key, because the key is derived from the server response.
3. Every gated IPC channel is allow-listed and requires an active lease. `access-policy.cjs` already does this shape for the Qwen launcher — reuse it.
4. Revocation is a server flag. The next lease request returns 403 and the module stays sealed.

That is the maximum honest strength. Claiming more would be a lie in the product.

---

## 4. Build order

1. **`forma-chat-store.cjs`** — the archive engine, rewritten. *This turn.*
2. **`forma-ui-guard.cjs`** — right-click suppression, hard. *This turn.*
3. **`license-service.mjs`** — server-side Ed25519 issue/verify/lease/revoke. *This turn.*
4. **`protected-loader.cjs`** — sealed module, lease-gated decryption. *This turn.*
5. Lock screen, admin hub, Discord channel, key site, auto-updater, installer — next unit.

Each ships complete and runnable. No stubs.
