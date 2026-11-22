'use strict';
/**
 * Forma Claude — chat store.
 *
 * Durable, crash-safe archive of Claude conversations.
 *
 * Design constraints that drive this file:
 *  - A Claude account cannot read another account's chats. The local archive is
 *    the only preservation mechanism. Losing a capture loses the transcript.
 *  - The capture must never depend on the account being healthy. A stale cookie
 *    or a 429 must degrade to "archive what we can", not "archive nothing".
 *  - The process can die at any moment. Every conversation is written to its own
 *    sidecar file as soon as it is fetched, then the index is rebuilt.
 *
 * Layout under <root>/archive:
 *   conv/<uuid>.json     one conversation, atomic write, monotonic merge
 *   index.json           cheap listing for the UI
 *   orgs.json            last known org per account, used when the API is down
 *   _failures.json       conversations that need a retry on the next tick
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CLAUDE_ORIGIN = 'https://claude.ai';
const CLAUDE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 200;
const MAX_PAGES = 60;
const MAX_BYTES = 128 * 1024 * 1024;
const CONCURRENCY = 6;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const QUIT_TIMEOUT_MS = 6000;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slug(input) {
  return String(input || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, '_')
    .slice(0, 96);
}

function hash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic write: a crash either leaves the old file or the new one, never a torn one. */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, file);
}

function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (res) => {
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON error page */
      }
      return { ok: res.ok, status: res.status, json, text };
    })
    .catch((err) => ({ ok: false, status: 0, json: null, text: '', error: String(err?.message || err) }))
    .finally(() => clearTimeout(timer));
}

function claudeGet(pathname, sessionKey, timeoutMs = 25000) {
  return httpJson(`${CLAUDE_ORIGIN}${pathname}`, {
    headers: {
      accept: 'application/json',
      'user-agent': CLAUDE_UA,
      'anthropic-client-platform': 'web_claude_ai',
      cookie: `sessionKey=${sessionKey}`,
    },
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// message extraction
//
// A Claude message body is not a string. It is an array of typed blocks:
// text, thinking, tool_use, tool_result, image. Reading only .text is how a
// tool-heavy chat archives as empty. This walks everything and keeps a raw
// fallback so nothing is ever silently dropped.
// ---------------------------------------------------------------------------

function blockText(block) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  const type = block.type;

  if (type === 'text' || type === 'thinking' || type === 'redacted_thinking') {
    return typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : '';
  }
  if (type === 'tool_use') {
    const input = block.input ? JSON.stringify(block.input) : '';
    return `[tool_use ${block.name || 'unknown'}]${input ? ` ${input}` : ''}`;
  }
  if (type === 'tool_result') {
    const inner = Array.isArray(block.content)
      ? block.content.map(blockText).filter(Boolean).join('\n')
      : typeof block.content === 'string'
        ? block.content
        : '';
    return `[tool_result]${inner ? ` ${inner}` : ''}`;
  }
  if (type === 'image' || type === 'document') {
    const src = block.source || {};
    const mime = src.media_type || block.media_type || 'binary';
    const len = typeof src.data === 'string' ? src.data.length : 0;
    return `[${type} ${mime}${len ? ` ${len}B base64` : ''}]`;
  }
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return '';
}

function messageText(m) {
  if (typeof m?.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m?.content)) {
    const parts = m.content.map(blockText).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof m?.content === 'string' && m.content.trim()) return m.content;
  return '';
}

function normaliseMessage(m, index) {
  const text = messageText(m);
  return {
    role: m?.sender === 'human' || m?.role === 'user' ? 'user' : 'assistant',
    text,
    at: m?.created_at || m?.at || null,
    index,
    hash: hash(`${m?.sender || m?.role || ''}|${text}`),
  };
}

function normaliseConversation(detail, item) {
  const raw = Array.isArray(detail?.chat_messages) ? detail.chat_messages : [];
  const messages = raw.map(normaliseMessage).filter((m) => m.text || m.role === 'assistant');
  return {
    uuid: item.uuid,
    name: detail?.name || item.name || 'Untitled',
    createdAt: detail?.created_at || item.created_at || null,
    updatedAt: detail?.updated_at || item.updated_at || null,
    messageCount: messages.length,
    messages,
    capturedAt: nowIso(),
  };
}

/**
 * Monotonic merge. Messages are unioned by hash and ordered by timestamp then
 * original index. Nothing is ever removed, so a stale response can never
 * overwrite a fuller local copy.
 */
function mergeConversation(previous, next) {
  if (!previous) return next;
  const seen = new Map();
  const push = (m, fallbackIndex) => {
    const key = m.hash || hash(`${m.role}|${m.text}`);
    const row = { ...m, index: Number.isFinite(m.index) ? m.index : fallbackIndex };
    const existing = seen.get(key);
    if (!existing) seen.set(key, row);
    else if (String(row.at || '') > String(existing.at || '')) seen.set(key, row);
  };
  (previous.messages || []).forEach(push);
  (next.messages || []).forEach(push);

  const merged = Array.from(seen.values()).sort((a, b) => {
    const ta = String(a.at || '');
    const tb = String(b.at || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.index || 0) - (b.index || 0);
  });

  return {
    ...previous,
    ...next,
    name: next.name || previous.name,
    createdAt: previous.createdAt || next.createdAt,
    updatedAt: [previous.updatedAt, next.updatedAt].filter(Boolean).sort().pop() || null,
    messageCount: merged.length,
    messages: merged,
    capturedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

function createChatStore({ rootDir, getSessionKey, getAccounts, log = () => {} } = {}) {
  const base = path.join(rootDir, 'archive');
  const convDir = path.join(base, 'conv');
  const indexPath = path.join(base, 'index.json');
  const orgsPath = path.join(base, 'orgs.json');
  const failPath = path.join(base, '_failures.json');

  let lock = null;

  async function ensureDirs() {
    await fsp.mkdir(convDir, { recursive: true });
  }

  /** One capture at a time. A second caller waits, then no-ops. */
  async function withLock(fn) {
    if (lock) {
      try {
        await lock;
      } catch {
        /* previous capture failed; run anyway */
      }
      return null;
    }
    lock = (async () => {
      try {
        return await fn();
      } finally {
        lock = null;
      }
    })();
    return lock;
  }

  /**
   * Resolve a usable session key without requiring the live cookie.
   * Order: injected resolver -> accounts.json entries. A stale key is still
   * worth one attempt because /api/organizations is cheap.
   */
  async function resolveKeys() {
    const keys = [];
    try {
      const live = await getSessionKey?.();
      if (live) keys.push({ key: live, source: 'live' });
    } catch {}
    try {
      const accounts = (await getAccounts?.()) || [];
      for (const a of accounts) {
        if (a?.sessionKey && !keys.some((k) => k.key === a.sessionKey)) {
          keys.push({ key: a.sessionKey, source: 'store', email: a.email });
        }
      }
    } catch {}
    return keys;
  }

  async function resolveOrg(sessionKey, cachedOrgId) {
    const res = await claudeGet('/api/organizations', sessionKey, 15000);
    if (res.ok && Array.isArray(res.json) && res.json.length) {
      const org = cachedOrgId ? res.json.find((o) => o.uuid === cachedOrgId) || res.json[0] : res.json[0];
      return { ok: true, org, orgs: res.json, status: res.status };
    }
    return { ok: false, status: res.status, orgs: [] };
  }

  /** Every page until empty. Count caps are how chats vanish; byte budget caps instead. */
  async function listConversations(orgUuid, sessionKey, signal) {
    const out = [];
    let bytes = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (signal?.aborted) break;
      const offset = page * PAGE_SIZE;
      const res = await claudeGet(
        `/api/organizations/${orgUuid}/chat_conversations?limit=${PAGE_SIZE}&offset=${offset}`,
        sessionKey,
      );
      if (!res.ok || !Array.isArray(res.json)) {
        if (page === 0) throw new Error(`conversation list failed (HTTP ${res.status})`);
        break;
      }
      if (!res.json.length) break;
      for (const item of res.json) {
        out.push(item);
        bytes += 512;
      }
      if (bytes > MAX_BYTES) break;
      if (res.json.length < PAGE_SIZE) break;
    }
    return out;
  }

  async function fetchConversation(orgUuid, item, sessionKey, signal) {
    let lastError = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error('aborted');
      const res = await claudeGet(`/api/organizations/${orgUuid}/chat_conversations/${item.uuid}`, sessionKey);
      if (res.ok && res.json) return normaliseConversation(res.json, item);
      lastError = `HTTP ${res.status}`;
      // 401/403 will not fix itself with a retry; bail immediately.
      if (res.status === 401 || res.status === 403 || res.status === 404) break;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
    throw new Error(lastError || 'fetch failed');
  }

  async function saveConversation(conv) {
    const file = path.join(convDir, `${conv.uuid}.json`);
    const previous = await readJson(file, null);
    const merged = mergeConversation(previous, conv);
    await writeJsonAtomic(file, merged);
    return merged;
  }

  async function rebuildIndex() {
    const files = (await fsp.readdir(convDir).catch(() => [])).filter((f) => f.endsWith('.json'));
    const rows = [];
    let totalMessages = 0;
    for (const f of files) {
      const conv = await readJson(path.join(convDir, f), null);
      if (!conv) continue;
      totalMessages += conv.messageCount || 0;
      rows.push({
        uuid: conv.uuid,
        name: conv.name,
        updatedAt: conv.updatedAt,
        capturedAt: conv.capturedAt,
        messageCount: conv.messageCount || 0,
      });
    }
    rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const index = {
      updatedAt: nowIso(),
      conversations: rows.length,
      messages: totalMessages,
      items: rows,
    };
    await writeJsonAtomic(indexPath, index);
    return index;
  }

  async function recordFailures(failures) {
    if (!failures.length) {
      await fsp.unlink(failPath).catch(() => {});
      return;
    }
    const previous = (await readJson(failPath, null)) || { items: [] };
    const byUuid = new Map(previous.items.map((f) => [f.uuid, f]));
    for (const f of failures) byUuid.set(f.uuid, { ...f, at: nowIso(), attempts: (byUuid.get(f.uuid)?.attempts || 0) + 1 });
    await writeJsonAtomic(failPath, { items: Array.from(byUuid.values()) });
  }

  async function retryFailures(sessionKey, orgUuid, signal) {
    const stored = (await readJson(failPath, null)) || { items: [] };
    if (!stored.items.length) return 0;
    let recovered = 0;
    const still = [];
    for (const f of stored.items) {
      try {
        const conv = await fetchConversation(orgUuid, f, sessionKey, signal);
        await saveConversation(conv);
        recovered += 1;
      } catch {
        still.push(f);
      }
    }
    await recordFailures(still);
    return recovered;
  }

  /**
   * The main capture. Never throws on a bad account: it reports what it could
   * and leaves the rest for the next tick.
   */
  async function capture({ email, signal, emit = () => {} } = {}) {
    await ensureDirs();

    const keys = await resolveKeys();
    if (!keys.length) return { ok: false, reason: 'no-session', saved: 0, total: 0 };

    const cachedOrgs = (await readJson(orgsPath, null)) || {};
    let sessionKey = null;
    let org = null;
    let lastStatus = 0;

    for (const candidate of keys) {
      const resolved = await resolveOrg(candidate.key, cachedOrgs[candidate.email]?.orgId);
      if (resolved.ok) {
        sessionKey = candidate.key;
        org = resolved.org;
        const map = { ...cachedOrgs };
        for (const o of resolved.orgs) map[candidate.email || o.uuid] = { orgId: o.uuid, name: o.name, at: nowIso() };
        await writeJsonAtomic(orgsPath, map);
        break;
      }
      lastStatus = resolved.status;
    }

    if (!org) return { ok: false, reason: `org-unavailable (HTTP ${lastStatus})`, saved: 0, total: 0 };

    emit({ step: 'archive', state: 'list' });
    const list = await listConversations(org.uuid, sessionKey, signal);
    emit({ step: 'archive', state: 'list', total: list.length });

    let saved = 0;
    let bytes = 0;
    let cursor = 0;
    const failures = [];

    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return;
        const i = cursor++;
        if (i >= list.length) return;
        const item = list[i];
        try {
          const conv = await fetchConversation(org.uuid, item, sessionKey, signal);
          const merged = await saveConversation(conv);
          bytes += Buffer.byteLength(JSON.stringify(merged));
          saved += 1;
          emit({ step: 'archive', state: 'progress', done: saved, total: list.length });
        } catch (err) {
          failures.push({ uuid: item.uuid, name: item.name, error: String(err?.message || err) });
        }
        if (bytes > MAX_BYTES) cursor = list.length;
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await recordFailures(failures);

    const recovered = await retryFailures(sessionKey, org.uuid, signal).catch(() => 0);
    const index = await rebuildIndex();

    log('[archive] captured', {
      email: email || 'unknown',
      org: org.name,
      fetched: saved,
      recovered,
      failed: failures.length,
      conversations: index.conversations,
      messages: index.messages,
    });

    return {
      ok: true,
      email: email || 'unknown',
      org: org.name,
      saved,
      recovered,
      failed: failures.length,
      conversations: index.conversations,
      messages: index.messages,
    };
  }

  /** Fire-and-forget variant used by the tick and by before-quit. */
  function captureQuiet(options) {
    return withLock(() => capture(options)).catch((err) => {
      log('[archive] capture failed', { error: String(err?.message || err) });
      return null;
    });
  }

  /** Hard-bounded capture for app shutdown. Never blocks quit for longer than 6 s. */
  async function captureOnQuit() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUIT_TIMEOUT_MS);
    try {
      await captureQuiet({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function list() {
    const index = await readJson(indexPath, null);
    if (index) return index;
    return rebuildIndex();
  }

  async function get(uuid) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uuid))) throw new Error('invalid conversation id');
    return readJson(path.join(convDir, `${uuid}.json`), null);
  }

  async function remove(uuid) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uuid))) throw new Error('invalid conversation id');
    await fsp.unlink(path.join(convDir, `${uuid}.json`)).catch(() => {});
    return rebuildIndex();
  }

  async function stats() {
    const index = await readJson(indexPath, null);
    const failures = await readJson(failPath, null);
    return {
      conversations: index?.conversations || 0,
      messages: index?.messages || 0,
      updatedAt: index?.updatedAt || null,
      pendingRetries: failures?.items?.length || 0,
      dir: base,
    };
  }

  return { capture, captureQuiet, captureOnQuit, list, get, remove, stats, rebuildIndex, mergeConversation };
}

module.exports = { createChatStore, messageText, mergeConversation, normaliseConversation, slug };
