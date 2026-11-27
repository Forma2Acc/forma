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
const PAGE_SIZE = 100;
const MAX_PAGES = 60;
const MAX_BYTES = 128 * 1024 * 1024;
const CONCURRENCY = 6;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const QUIT_TIMEOUT_MS = 6000;
const BARRIER_TIMEOUT_MS = 60000;
const DPAPI_TAG = 'dpapi-v1';

function nowIso() {
  return new Date().toISOString();
}

function parseTs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const n = Date.parse(String(val || ''));
  return Number.isFinite(n) ? n : 0;
}

function sha256Hex(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
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

/** Crash-safe atomic write: temp file -> fsync -> close -> rename. */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  const data = JSON.stringify(value);
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'w');
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  await fsp.rename(tmp, file);
  return data;
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

function normaliseConversation(detail, item, email = null) {
  const raw = Array.isArray(detail?.chat_messages) ? detail.chat_messages : [];
  const messages = raw.map(normaliseMessage).filter((m) => m.text || m.role === 'assistant');
  return {
    uuid: item.uuid || detail?.uuid,
    name: detail?.name || item.name || 'Untitled',
    email: email || item.email || detail?._forma?.accountEmail || null,
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
    name: next.name && next.name !== 'Untitled' ? next.name : previous.name || next.name,
    email: previous.email || next.email || null,
    createdAt: previous.createdAt || next.createdAt,
    updatedAt: [previous.updatedAt, next.updatedAt].filter(Boolean).sort().pop() || null,
    messageCount: merged.length,
    messages: merged,
    capturedAt: nowIso(),
  };
}

function synthesiseRawConversation(conv) {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  let prevUuid = '00000000-0000-4000-8000-000000000000';
  const chatMessages = messages.map((m, idx) => {
    const msgUuid = m.uuid || crypto.createHash('md5').update(`${conv.uuid}:${idx}:${m.text || ''}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-4$3-8$4-$5');
    const isHuman = m.role === 'user' || m.sender === 'human';
    const text = String(m.text || '');
    const row = {
      uuid: msgUuid,
      text,
      content: [{ type: 'text', text }],
      sender: isHuman ? 'human' : 'assistant',
      index: idx,
      created_at: m.at || conv.createdAt || nowIso(),
      updated_at: m.at || conv.updatedAt || nowIso(),
      truncated: false,
      parent_message_uuid: prevUuid,
      attachments: [],
      files: [],
      sync_sources: [],
    };
    prevUuid = msgUuid;
    return row;
  });
  return {
    uuid: conv.uuid,
    name: conv.name || 'Untitled',
    summary: '',
    model: null,
    created_at: conv.createdAt || nowIso(),
    updated_at: conv.updatedAt || conv.createdAt || nowIso(),
    settings: {},
    is_starred: false,
    is_archived: false,
    is_wiggle_enabled: false,
    workspace_upgraded: false,
    is_multiplayer: false,
    is_temporary: false,
    platform: 'CLAUDE_AI',
    offers_allowed: true,
    current_leaf_message_uuid: chatMessages.length ? chatMessages[chatMessages.length - 1].uuid : null,
    project_uuid: null,
    chat_messages: chatMessages,
    _forma: {
      synthesised: true,
      accountEmail: conv.email || null,
      capturedAt: conv.capturedAt || nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

function createChatStore({ rootDir, getSessionKey, getAccounts, safeStorage = null, log = () => {} } = {}) {
  const base = path.join(rootDir, 'archive');
  const convDir = path.join(base, 'conv');
  const rawDir = path.join(base, 'raw');
  const blobsDir = path.join(base, 'blobs');
  const indexPath = path.join(base, 'index.json');
  const orgsPath = path.join(base, 'orgs.json');
  const failPath = path.join(base, '_failures.json');
  const aliasesPath = path.join(base, 'aliases.json');
  const journalPath = path.join(base, 'journal.ndjson');
  const snapshotPath = path.join(base, 'pre-reset-snapshot.json');

  let lock = null;
  let migrated = false;
  let journalReplayed = false;
  let indexCache = null;
  let indexCacheMtimeMs = -1;

  function canEncryptAtRest() {
    try {
      return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  async function readConvJson(file, fallback = null) {
    const parsed = await readJson(file, null);
    if (!parsed) return fallback;
    if (parsed && parsed.__forma_enc === DPAPI_TAG && typeof parsed.data === 'string') {
      if (!canEncryptAtRest()) return fallback;
      try {
        const plain = safeStorage.decryptString(Buffer.from(parsed.data, 'base64'));
        return JSON.parse(plain);
      } catch {
        return fallback;
      }
    }
    return parsed;
  }

  async function writeConvJsonAtomic(file, value) {
    if (canEncryptAtRest()) {
      try {
        const enc = safeStorage.encryptString(JSON.stringify(value));
        return writeJsonAtomic(file, { __forma_enc: DPAPI_TAG, data: enc.toString('base64') });
      } catch {
        /* fallback to atomic plaintext if DPAPI throws */
      }
    }
    return writeJsonAtomic(file, value);
  }

  async function appendJournal(entry) {
    try {
      await fsp.mkdir(base, { recursive: true });
      const line = `${JSON.stringify({ ...entry, at: nowIso() })}\n`;
      let fh = null;
      try {
        fh = await fsp.open(journalPath, 'a');
        await fh.writeFile(line, 'utf8');
        await fh.sync();
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    } catch {}
  }

  async function writeRawBlob(rawObj) {
    try {
      const jsonText = JSON.stringify(rawObj);
      const digest = sha256Hex(jsonText);
      const blobFile = path.join(blobsDir, `${digest}.json`);
      if (!fs.existsSync(blobFile)) {
        await writeConvJsonAtomic(blobFile, rawObj);
      }
      return digest;
    } catch {
      return null;
    }
  }

  async function replayJournal() {
    if (journalReplayed) return 0;
    journalReplayed = true;
    if (!fs.existsSync(journalPath)) return 0;
    let replayed = 0;
    try {
      const rawText = await fsp.readFile(journalPath, 'utf8');
      const lines = rawText.split(/\r?\n/).filter(Boolean);
      const pending = new Map();
      for (const line of lines) {
        let ev = null;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev?.uuid) continue;
        if (ev.op === 'begin' || ev.op === 'blob') pending.set(ev.uuid, ev);
        else if (ev.op === 'commit') pending.delete(ev.uuid);
      }
      for (const [uuid, ev] of pending.entries()) {
        if (ev.sha256) {
          const blobFile = path.join(blobsDir, `${ev.sha256}.json`);
          const blobRaw = await readConvJson(blobFile, null);
          if (blobRaw && blobRaw.uuid) {
            const conv = normaliseConversation(blobRaw, blobRaw, blobRaw?._forma?.accountEmail || null);
            await saveConversation(conv, blobRaw, true);
            replayed += 1;
          }
        }
      }
      if (replayed > 0) {
        await rebuildIndex();
        log('[archive] replayed journal entries', { replayed });
      }
      // Compact journal once cleanly replayed if it grew large
      if (lines.length > 500 && pending.size === 0) {
        await fsp.writeFile(journalPath, '', 'utf8').catch(() => {});
      }
    } catch {}
    return replayed;
  }

  async function ensureDirs() {
    await fsp.mkdir(convDir, { recursive: true });
    await fsp.mkdir(rawDir, { recursive: true });
    await fsp.mkdir(blobsDir, { recursive: true });
  }

  /** Serialize captures so a critical pre-switch capture never no-ops behind a background tick. */
  async function withLock(fn) {
    const prev = lock;
    const current = (async () => {
      if (prev) {
        try {
          await prev;
        } catch {}
      }
      return await fn();
    })();
    lock = current.finally(() => {
      if (lock === current) lock = null;
    });
    return current;
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
      const chatOrg = res.json.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
      const org = cachedOrgId ? res.json.find((o) => o.uuid === cachedOrgId) || chatOrg || res.json[0] : chatOrg || res.json[0];
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

  async function fetchConversation(orgUuid, item, sessionKey, signal, email = null) {
    let lastError = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error('aborted');
      let res = await claudeGet(
        `/api/organizations/${orgUuid}/chat_conversations/${item.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
        sessionKey,
      );
      if (res.status === 400) {
        res = await claudeGet(`/api/organizations/${orgUuid}/chat_conversations/${item.uuid}`, sessionKey);
      }
      if (res.ok && res.json) {
        return {
          raw: { ...res.json, _forma: { accountEmail: email || null, orgUuid, capturedAt: nowIso() } },
          conv: normaliseConversation(res.json, item, email),
        };
      }
      lastError = `HTTP ${res.status}`;
      // 401/403 will not fix itself with a retry; bail immediately.
      if (res.status === 401 || res.status === 403 || res.status === 404) break;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
    throw new Error(lastError || 'fetch failed');
  }

  const ROOT_MSG_UUID = '00000000-0000-4000-8000-000000000000';

  function stripFormaWrappers(text) {
    let t = String(text || '');
    if (!t) return '';
    t = t.replace(/\[FORMA_CONTEXT\][\s\S]*?\[\/FORMA_CONTEXT\]\s*/g, '');
    const cm = t.match(/^\[Continued from archived chat[^\]]*\][\s\S]*?\n\[Current message\]\n([\s\S]*)$/);
    if (cm) t = cm[1];
    return t.trimStart();
  }

  function cleanMessageForRaw(m, idx, prevUuid, fallbackConvId) {
    const isHuman = m?.sender === 'human' || m?.role === 'user';
    const sender = isHuman ? 'human' : 'assistant';
    const rawTxt = messageText(m);
    const hadFormaCtx = rawTxt.includes('[FORMA_CONTEXT]');
    const text = isHuman ? stripFormaWrappers(rawTxt) : rawTxt;
    const rawBlocks = Array.isArray(m?.content) ? m.content : [];
    const filteredBlocks = rawBlocks
      .filter((b) => {
        if (!b || typeof b !== 'object') return false;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('This block is not supported on your current device yet')) {
          return rawBlocks.length <= 1 && !text;
        }
        return true;
      })
      .map((b) => {
        if (b.type === 'tool_use') {
          return {
            ...b,
            id: b.id || `tool_${idx}_${fallbackConvId || 'local'}`,
            name: b.name || 'tool',
            input: b.input && typeof b.input === 'object' ? b.input : {},
          };
        }
        return b;
      });
    let content = filteredBlocks.length ? filteredBlocks : [{ type: 'text', text }];
    if (isHuman && text !== rawTxt) {
      content = [{ type: 'text', text }];
    }
    const uuid = /^[a-f0-9-]{36}$/i.test(String(m?.uuid || ''))
      ? m.uuid
      : crypto
          .createHash('md5')
          .update(`${fallbackConvId || 'local'}:${idx}:${text}`)
          .digest('hex')
          .replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-4$3-8$4-$5');
    return {
      ...m,
      uuid,
      sender,
      text,
      content,
      index: idx,
      parent_message_uuid: prevUuid || ROOT_MSG_UUID,
      truncated: false,
      attachments: Array.isArray(m?.attachments) ? m.attachments : [],
      files: Array.isArray(m?.files) ? m.files : [],
      sync_sources: Array.isArray(m?.sync_sources) ? m.sync_sources : [],
      created_at: m?.created_at || m?.at || nowIso(),
      updated_at: m?.updated_at || m?.created_at || m?.at || nowIso(),
      ...(hadFormaCtx ? { _forma_had_ctx: true } : {}),
    };
  }

  function msgRichness(m) {
    const blocks = Array.isArray(m?.content) ? m.content.length : 0;
    const rawTxt = messageText(m);
    const hasStub = rawTxt.includes('This block is not supported on your current device yet');
    return (hasStub ? 0 : 1000) + blocks * 10 + Math.min(9, Math.floor(rawTxt.length / 500));
  }

  function mergeRawMessages(prevMsgs, nextMsgs, fallbackConvId) {
    const out = [];
    const seenIdx = new Map();
    const pushList = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        const id = m.uuid && String(m.uuid);
        if (id && seenIdx.has(id)) {
          const idx = seenIdx.get(id);
          if (msgRichness(m) > msgRichness(out[idx])) out[idx] = m;
          continue;
        }
        if (id) seenIdx.set(id, out.length);
        out.push(m);
      }
    };
    pushList(prevMsgs);
    pushList(nextMsgs);
    let prevUuid = ROOT_MSG_UUID;
    return out.map((m, idx) => {
      const clean = cleanMessageForRaw(m, idx, prevUuid, fallbackConvId);
      prevUuid = clean.uuid;
      return clean;
    });
  }

  function sanitiseRawForReplay(raw, canonicalUuid) {
    const msgs = mergeRawMessages(raw?.chat_messages || [], [], canonicalUuid);
    const leaf = msgs.length ? msgs[msgs.length - 1].uuid : null;
    const cleaned = {
      ...raw,
      uuid: canonicalUuid,
      name: raw?.name || 'Untitled',
      summary: raw?.summary || '',
      model: null,
      project_uuid: null,
      settings: { preview_feature_uses_artifacts: true, enabled_web_search: true },
      platform: 'CLAUDE_AI',
      is_starred: Boolean(raw?.is_starred),
      is_archived: false,
      is_locked: false,
      locked: false,
      read_only: false,
      is_read_only: false,
      disabled: false,
      is_disabled: false,
      is_shared: false,
      is_ended: false,
      is_temporary: false,
      is_multiplayer: false,
      is_wiggle_enabled: false,
      workspace_upgraded: false,
      offers_allowed: true,
      chat_messages: msgs,
      current_leaf_message_uuid: leaf,
      created_at: raw?.created_at || nowIso(),
      updated_at: raw?.updated_at || nowIso(),
    };
    delete cleaned.project;
    delete cleaned.blocked_reason;
    delete cleaned.disabled_reason;
    delete cleaned.lock_reason;
    delete cleaned.share_uuid;
    delete cleaned.share_link_uuid;
    delete cleaned.organization_uuid;
    delete cleaned.org_uuid;
    delete cleaned.account_uuid;
    delete cleaned.creator;
    delete cleaned.permissions;
    delete cleaned.ended_at;
    return cleaned;
  }

  async function saveRawOnly(raw, email = null) {
    if (!raw?.uuid) return null;
    const uuid = String(raw.uuid);
    if (!/^[a-f0-9-]{36}$/i.test(uuid)) return null;
    const file = path.join(rawDir, `${uuid}.json`);
    const prev = await readConvJson(file, null);
    const prevLen = Array.isArray(prev?.chat_messages) ? prev.chat_messages.length : 0;
    const nextLen = Array.isArray(raw?.chat_messages) ? raw.chat_messages.length : 0;
    const mergedMsgs = mergeRawMessages(prev?.chat_messages || [], raw?.chat_messages || [], uuid);
    const prevScore = (prev?.chat_messages || []).reduce((s, m) => s + msgRichness(m), 0);
    const mergedScore = mergedMsgs.reduce((s, m) => s + msgRichness(m), 0);
    if (!prev || nextLen >= prevLen || mergedMsgs.length > prevLen || mergedScore > prevScore) {
      const payload = {
        ...prev,
        ...raw,
        uuid,
        chat_messages: mergedMsgs.length >= nextLen ? mergedMsgs : raw.chat_messages,
        _forma: {
          ...(prev?._forma || {}),
          ...(raw._forma || {}),
          accountEmail: email || raw._forma?.accountEmail || prev?._forma?.accountEmail || null,
          capturedAt: nowIso(),
        },
      };
      const digest = await writeRawBlob(payload);
      if (digest) await appendJournal({ op: 'blob', uuid, sha256: digest });
      await writeConvJsonAtomic(file, payload);
      return digest;
    }
    return null;
  }

  async function saveConversation(conv, raw = null, _skipAliasSync = false) {
    const file = path.join(convDir, `${conv.uuid}.json`);
    const previous = await readConvJson(file, null);
    const merged = mergeConversation(previous, conv);
    await writeConvJsonAtomic(file, merged);
    let digest = null;
    if (raw) {
      digest = await saveRawOnly(raw, merged.email);
      if (!_skipAliasSync) {
        const rootUuid = await findRootByAliasUuid(raw.uuid);
        if (rootUuid && rootUuid.toLowerCase() !== String(raw.uuid).toLowerCase()) {
          const rootRawFile = path.join(rawDir, `${rootUuid}.json`);
          const prevRootRaw = (await readConvJson(rootRawFile, null)) || sanitiseRawForReplay({ uuid: rootUuid, name: raw.name }, rootUuid);
          const mergedMsgs = mergeRawMessages(prevRootRaw.chat_messages || [], raw.chat_messages || [], rootUuid);
          const nextRootRaw = {
            ...prevRootRaw,
            uuid: rootUuid,
            name: prevRootRaw.name && prevRootRaw.name !== 'Continued chat' && prevRootRaw.name !== 'Untitled' ? prevRootRaw.name : (raw.name || prevRootRaw.name || 'Untitled'),
            updated_at: raw.updated_at || nowIso(),
            chat_messages: mergedMsgs,
            current_leaf_message_uuid: mergedMsgs.length ? mergedMsgs[mergedMsgs.length - 1].uuid : prevRootRaw.current_leaf_message_uuid,
          };
          const rootConv = normaliseConversation(nextRootRaw, nextRootRaw, merged.email);
          await saveConversation(rootConv, nextRootRaw, true);
        }
      }
    }
    await appendJournal({ op: 'commit', uuid: conv.uuid, sha256: digest });
    return merged;
  }

  async function rebuildIndex() {
    const prevIndex = await readJson(indexPath, null);
    const nextRev = Number(prevIndex?.rev || 0) + 1;
    const files = (await fsp.readdir(convDir).catch(() => [])).filter((f) => f.endsWith('.json'));
    const rows = [];
    let totalMessages = 0;
    for (const f of files) {
      const conv = await readConvJson(path.join(convDir, f), null);
      if (!conv) continue;
      const raw = await readConvJson(path.join(rawDir, f), null);
      const rawMsgs = Array.isArray(raw?.chat_messages) ? raw.chat_messages : [];
      const leafUuid = raw?.current_leaf_message_uuid || (rawMsgs.length ? rawMsgs[rawMsgs.length - 1]?.uuid || null : null);
      const msgCount = Math.max(conv.messageCount || 0, rawMsgs.length);
      totalMessages += msgCount;
      rows.push({
        uuid: conv.uuid,
        name: conv.name,
        email: conv.email || null,
        createdAt: conv.createdAt || raw?.created_at || null,
        updatedAt: conv.updatedAt || raw?.updated_at || conv.capturedAt,
        capturedAt: conv.capturedAt,
        messageCount: msgCount,
        leafUuid,
      });
    }
    rows.sort((a, b) => {
      const tb = parseTs(b.updatedAt || b.capturedAt || b.createdAt);
      const ta = parseTs(a.updatedAt || a.capturedAt || a.createdAt);
      if (tb !== ta) return tb - ta;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    const index = {
      rev: nextRev,
      updatedAt: nowIso(),
      conversations: rows.length,
      messages: totalMessages,
      items: rows,
    };
    const serialized = await writeJsonAtomic(indexPath, index);
    indexCache = index;
    try {
      const st = await fsp.stat(indexPath);
      indexCacheMtimeMs = st.mtimeMs;
    } catch {
      indexCacheMtimeMs = Date.now();
    }
    return { ...index, _sha256: sha256Hex(serialized) };
  }

  async function migrateLegacyArchives() {
    if (migrated) return 0;
    migrated = true;
    await ensureDirs();
    const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
    let imported = 0;
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      if (['index.json', 'orgs.json', '_failures.json', 'aliases.json'].includes(ent.name)) continue;
      const legacy = await readJson(path.join(base, ent.name), null);
      if (!legacy || !Array.isArray(legacy.conversations)) continue;
      const email = legacy.email || null;
      for (const c of legacy.conversations) {
        if (!c?.uuid || !/^[a-f0-9-]{36}$/i.test(String(c.uuid))) continue;
        const norm = {
          uuid: c.uuid,
          name: c.name || 'Untitled',
          email,
          createdAt: c.createdAt || null,
          updatedAt: c.updatedAt || null,
          messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
          messages: (c.messages || []).map((m, idx) => normaliseMessage(m, idx)),
          capturedAt: legacy.capturedAt || nowIso(),
        };
        await saveConversation(norm);
        const rawFile = path.join(rawDir, `${c.uuid}.json`);
        if (!fs.existsSync(rawFile)) {
          await writeJsonAtomic(rawFile, synthesiseRawConversation(norm)).catch(() => {});
        }
        imported += 1;
      }
    }
    if (imported > 0) {
      await rebuildIndex();
      log('[archive] imported legacy snapshots', { imported });
    }
    return imported;
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

  async function retryFailures(sessionKey, orgUuid, signal, email = null) {
    const stored = (await readJson(failPath, null)) || { items: [] };
    if (!stored.items.length) return 0;
    let recovered = 0;
    const still = [];
    for (const f of stored.items) {
      try {
        const fetched = await fetchConversation(orgUuid, f, sessionKey, signal, email);
        await saveConversation(fetched.conv, fetched.raw);
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
  async function capture({ email, signal, emit = () => {}, allAccounts = false } = {}) {
    await ensureDirs();
    await migrateLegacyArchives().catch(() => {});

    const keys = await resolveKeys();
    if (!keys.length) return { ok: false, reason: 'no-session', saved: 0, total: 0 };

    const cachedOrgs = (await readJson(orgsPath, null)) || {};
    const orgsMap = { ...cachedOrgs };
    const targets = [];
    let lastStatus = 0;

    for (const candidate of keys) {
      if (signal?.aborted) break;
      const resolved = await resolveOrg(candidate.key, orgsMap[candidate.email]?.orgId);
      if (resolved.ok) {
        const candEmail = candidate.email || (candidate.source === 'live' ? email : null) || resolved.org.name || null;
        for (const o of resolved.orgs) orgsMap[candEmail || o.uuid] = { orgId: o.uuid, name: o.name, at: nowIso() };
        targets.push({ sessionKey: candidate.key, org: resolved.org, email: candEmail });
        if (!allAccounts) break;
      } else {
        lastStatus = resolved.status;
      }
    }
    if (targets.length) await writeJsonAtomic(orgsPath, orgsMap).catch(() => {});

    if (!targets.length) return { ok: false, reason: `org-unavailable (HTTP ${lastStatus})`, saved: 0, total: 0 };

    let saved = 0;
    let recovered = 0;
    let failedCount = 0;

    for (const target of targets) {
      if (signal?.aborted) break;
      emit({ step: 'archive', state: 'list' });
      let list = [];
      try {
        list = await listConversations(target.org.uuid, target.sessionKey, signal);
      } catch {
        continue;
      }
      emit({ step: 'archive', state: 'list', total: list.length });

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
            const fetched = await fetchConversation(target.org.uuid, item, target.sessionKey, signal, target.email);
            const merged = await saveConversation(fetched.conv, fetched.raw);
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
      failedCount += failures.length;
      recovered += await retryFailures(target.sessionKey, target.org.uuid, signal, target.email).catch(() => 0);
    }

    const index = await rebuildIndex();
    const primary = targets[0];

    log('[archive] captured', {
      email: primary.email || email || 'unknown',
      org: primary.org.name,
      fetched: saved,
      recovered,
      failed: failedCount,
      conversations: index.conversations,
      messages: index.messages,
    });

    return {
      ok: true,
      email: primary.email || email || 'unknown',
      org: primary.org.name,
      saved,
      recovered,
      failed: failedCount,
      conversations: index.conversations,
      messages: index.messages,
    };
  }

  /**
   * Blocking pre-reset capture barrier (§4.1.1).
   * Reads ONLY the live cookie jar (getSessionKey), paginates all conversations
   * (limit=100), writes content-addressed blobs + atomic conv/raw + journal,
   * rebuilds index.json with monotonic rev, writes pre-reset-snapshot.json,
   * and verifies completeness before returning ok:true.
   */
  async function captureBarrier({ email = null, signal = null, emit = () => {}, timeoutMs = BARRIER_TIMEOUT_MS } = {}) {
    return withLock(async () => {
      await ensureDirs();
      await migrateLegacyArchives().catch(() => {});
      await replayJournal().catch(() => {});

      const sessionKey = await getSessionKey?.().catch(() => null);
      if (!sessionKey) {
        return { ok: false, incomplete: true, reason: 'no live session cookie; nothing was reset', captured: 0, expected: 0 };
      }

      const barrierCtrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        barrierCtrl.abort();
      }, Math.max(5000, Number(timeoutMs) || BARRIER_TIMEOUT_MS));

      const onParentAbort = () => barrierCtrl.abort();
      if (signal) {
        if (signal.aborted) barrierCtrl.abort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
      }

      try {
        const [acctRes, orgRes] = await Promise.all([
          claudeGet('/api/account', sessionKey, 15000).catch(() => null),
          resolveOrg(sessionKey, null),
        ]);
        if (!orgRes.ok || !orgRes.org?.uuid) {
          return {
            ok: false,
            incomplete: true,
            reason: `session unavailable (HTTP ${orgRes.status || 0}); nothing was reset`,
            captured: 0,
            expected: 0,
          };
        }
        const org = orgRes.org;
        const accountUuid = acctRes?.ok ? acctRes.json?.uuid || null : null;
        const resolvedEmail = (acctRes?.ok && acctRes.json?.email_address) || email || org.name || 'unknown';

        emit({ step: 'archive', state: 'list', message: 'Reading conversations…' });
        let list = [];
        try {
          list = await listConversations(org.uuid, sessionKey, barrierCtrl.signal);
        } catch (err) {
          return {
            ok: false,
            incomplete: true,
            timedOut,
            reason: `conversation list failed (${err?.message || err}); nothing was reset`,
            captured: 0,
            expected: 0,
          };
        }

        const expected = list.length;
        emit({ step: 'archive', state: 'list', total: expected, message: `Archiving ${expected} conversations…` });

        let captured = 0;
        let emptyCount = 0;
        let lossyCount = 0;
        let bytes = 0;
        let cursor = 0;
        const failures = [];

        // A conversation with 0 messages is legitimate (blank chat, draft,
        // deleted turns). It only means data loss when the live list itself
        // reports messages for that conversation.
        const listMessageCount = (it) => {
          if (!it) return null;
          const cands = [it.message_count, it.messages_count, it.num_messages, it.total_messages];
          if (Array.isArray(it.chat_messages)) cands.push(it.chat_messages.length);
          for (const v of cands) {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) return n;
          }
          return null;
        };

        const worker = async () => {
          for (;;) {
            if (barrierCtrl.signal.aborted) return;
            const i = cursor++;
            if (i >= list.length) return;
            const item = list[i];
            try {
              await appendJournal({ op: 'begin', uuid: item.uuid });
              const fetched = await fetchConversation(org.uuid, item, sessionKey, barrierCtrl.signal, resolvedEmail);
              const merged = await saveConversation(fetched.conv, fetched.raw);
              bytes += Buffer.byteLength(JSON.stringify(merged));
              captured += 1;
              if ((merged.messageCount || 0) < 1) {
                emptyCount += 1;
                const expectedMsgs = listMessageCount(item);
                if (expectedMsgs !== null && expectedMsgs > 0) lossyCount += 1;
              }
              emit({
                step: 'archive',
                state: 'progress',
                done: captured,
                total: expected,
                message: `Archiving ${captured} of ${expected} conversations…`,
              });
            } catch (err) {
              failures.push({ uuid: item.uuid, name: item.name, error: String(err?.message || err) });
            }
            if (bytes > MAX_BYTES) cursor = list.length;
          }
        };

        if (expected > 0) {
          await Promise.all(Array.from({ length: CONCURRENCY }, worker));
          if (failures.length && !barrierCtrl.signal.aborted) {
            // Retry ONLY the current barrier's failed items so stale failures from other accounts never inflate captured
            const stillFailed = [];
            for (const f of failures) {
              if (barrierCtrl.signal.aborted) {
                stillFailed.push(f);
                continue;
              }
              try {
                await appendJournal({ op: 'begin', uuid: f.uuid });
                const fetched = await fetchConversation(org.uuid, f, sessionKey, barrierCtrl.signal, resolvedEmail);
                const merged = await saveConversation(fetched.conv, fetched.raw);
                captured += 1;
                if ((merged.messageCount || 0) < 1) {
                  emptyCount += 1;
                  const expectedMsgs = listMessageCount(f);
                  if (expectedMsgs !== null && expectedMsgs > 0) lossyCount += 1;
                }
              } catch (err) {
                stillFailed.push({ ...f, error: String(err?.message || err) });
              }
            }
            await recordFailures(stillFailed);
          } else if (!failures.length) {
            await recordFailures([]);
          }
        }

        const index = await rebuildIndex();
        const sha256OfIndex = index._sha256 || sha256Hex(JSON.stringify(index));
        const complete = !timedOut && !barrierCtrl.signal.aborted && captured >= expected && lossyCount === 0;

        const snapshot = {
          accountUuid,
          orgUuid: org.uuid,
          email: resolvedEmail,
          capturedAt: nowIso(),
          rev: index.rev || 1,
          conversationCount: index.conversations,
          liveCaptured: captured,
          liveListCount: expected,
          emptyCount,
          messageCount: index.messages,
          sha256OfIndex,
          complete,
        };
        await writeJsonAtomic(snapshotPath, snapshot);

        if (!complete) {
          const detail = timedOut
            ? `capture timed out after ${Math.round((timeoutMs || BARRIER_TIMEOUT_MS) / 1000)}s: ${captured} of ${expected} conversations`
            : captured < expected
              ? `capture incomplete: ${captured} of ${expected} conversations; nothing was reset`
              : `capture incomplete: ${lossyCount} conversation(s) reported messages but came back empty; nothing was reset`;
          log('[archive] barrier blocked reset', { captured, expected, emptyCount, lossyCount, timedOut });
          return {
            ok: false,
            incomplete: true,
            timedOut,
            reason: detail,
            captured,
            expected,
            emptyCount,
            lossyCount,
            conversations: index.conversations,
            messages: index.messages,
            snapshot,
          };
        }

        log('[archive] barrier passed', {
          email: resolvedEmail,
          org: org.name,
          liveCaptured: captured,
          liveListCount: expected,
          emptyCount,
          lossyCount,
          conversations: index.conversations,
          messages: index.messages,
          rev: index.rev,
        });

        return {
          ok: true,
          complete: true,
          email: resolvedEmail,
          org: org.name,
          captured,
          expected,
          emptyCount,
          lossyCount,
          conversations: index.conversations,
          messages: index.messages,
          rev: index.rev,
          snapshot,
        };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onParentAbort);
      }
    });
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

  async function readIndexCached() {
    await migrateLegacyArchives().catch(() => {});
    await replayJournal().catch(() => {});
    try {
      const st = await fsp.stat(indexPath);
      if (indexCache && indexCacheMtimeMs === st.mtimeMs) {
        return indexCache;
      }
      const parsed = await readJson(indexPath, null);
      if (parsed && Array.isArray(parsed.items)) {
        indexCache = parsed;
        indexCacheMtimeMs = st.mtimeMs;
        return parsed;
      }
    } catch {}
    return rebuildIndex();
  }

  async function listIndex({ offset = 0, limit = 0, sinceDays = 0 } = {}) {
    const index = await readIndexCached();
    let items = Array.isArray(index.items) ? index.items : [];
    if (sinceDays > 0) {
      const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
      items = items.filter((c) => parseTs(c.updatedAt || c.capturedAt || c.createdAt) >= cutoff);
    }
    const total = items.length;
    const start = Math.max(0, Number(offset) || 0);
    const lim = Number(limit) || 0;
    const pageItems = lim > 0 ? items.slice(start, start + lim) : items.slice(start);
    return {
      rev: index.rev || 0,
      updatedAt: index.updatedAt || null,
      conversations: index.conversations || total,
      messages: index.messages || 0,
      total,
      offset: start,
      limit: lim || total,
      hasMore: lim > 0 ? start + pageItems.length < total : false,
      items: pageItems,
    };
  }

  async function list(opts) {
    if (opts && (opts.offset || opts.limit || opts.sinceDays)) {
      return listIndex(opts);
    }
    return readIndexCached();
  }

  async function get(uuid) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uuid))) throw new Error('invalid conversation id');
    return readConvJson(path.join(convDir, `${uuid}.json`), null);
  }

  async function findRootByAliasUuid(targetUuid, mapIn = null) {
    const map = mapIn || (await readJson(aliasesPath, null)) || {};
    let cur = String(targetUuid || '').toLowerCase();
    const visited = new Set();
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      let parent = null;
      for (const [k, v] of Object.entries(map)) {
        if (v && String(v.newUuid || '').toLowerCase() === cur) {
          const idx = k.indexOf(':');
          const oldId = idx >= 0 ? k.slice(idx + 1) : '';
          if (/^[a-f0-9-]{36}$/i.test(oldId)) {
            parent = oldId;
            break;
          }
        }
      }
      if (!parent || parent.toLowerCase() === cur) break;
      cur = parent.toLowerCase();
    }
    return cur || targetUuid;
  }

  async function saveRaw(raw, email = null) {
    if (!raw?.uuid || !/^[a-f0-9-]{36}$/i.test(String(raw.uuid))) return null;
    await ensureDirs();
    const conv = normaliseConversation(raw, raw, email);
    const merged = await saveConversation(conv, raw);
    await rebuildIndex().catch(() => {});
    return merged;
  }

  async function getRaw(uuid) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uuid))) return null;
    await migrateLegacyArchives().catch(() => {});
    await replayJournal().catch(() => {});
    const rawFile = path.join(rawDir, `${uuid}.json`);
    let raw = await readConvJson(rawFile, null);
    if (!raw || !Array.isArray(raw.chat_messages) || raw.chat_messages.length === 0) {
      const conv = await get(uuid);
      if (conv && Array.isArray(conv.messages) && conv.messages.length > 0) {
        raw = synthesiseRawConversation(conv);
        await writeConvJsonAtomic(rawFile, raw).catch(() => {});
      }
    }
    if (!raw || !Array.isArray(raw.chat_messages) || raw.chat_messages.length === 0) {
      // Live multi-account recovery: try live cookie first, then stored accounts vault
      try {
        const candidates = await resolveKeys();
        for (const cand of candidates) {
          if (!cand?.key) continue;
          const orgRes = await resolveOrg(cand.key, null).catch(() => null);
          if (!orgRes?.ok || !orgRes.org?.uuid) continue;
          const fetched = await fetchConversation(
            orgRes.org.uuid,
            { uuid, name: raw?.name },
            cand.key,
            null,
            cand.email || null,
          ).catch(() => null);
          if (fetched?.raw && Array.isArray(fetched.raw.chat_messages) && fetched.raw.chat_messages.length > 0) {
            await saveRaw(fetched.raw, cand.email || null).catch(() => {});
            raw = fetched.raw;
            log('[archive] recovered live across accounts', {
              uuid,
              source: cand.source,
              email: cand.email || null,
              msgs: raw.chat_messages.length,
            });
            break;
          }
        }
      } catch {}
    }
    if (!raw) return null;
    return sanitiseRawForReplay(raw, uuid);
  }

  async function getAliasMap() {
    const map = (await readJson(aliasesPath, null)) || {};
    const forward = {};
    for (const [k, v] of Object.entries(map)) {
      if (v && v.newUuid) forward[k] = v.newUuid;
    }
    return forward;
  }

  /**
   * Index-only sidebar listing (D1, D3, D19).
   * Never hides rows via hiddenTargets and never scans the filesystem per row.
   * Logs explicit exclusion reasons so index count and returned count reconcile 100%.
   */
  async function listForSidebar({ offset = 0, limit = 0 } = {}) {
    const index = await readIndexCached();
    const seen = new Set();
    const out = [];
    const excluded = [];
    for (const c of index.items || []) {
      if (!c?.uuid) {
        excluded.push({ reason: 'missing-uuid' });
        continue;
      }
      const lower = String(c.uuid).toLowerCase();
      if (seen.has(lower)) {
        excluded.push({ uuid: c.uuid, reason: 'duplicate-index-entry' });
        continue;
      }
      seen.add(lower);
      out.push({
        uuid: c.uuid,
        name: c.name || 'Untitled',
        summary: '',
        model: null,
        created_at: c.createdAt || c.updatedAt || c.capturedAt || nowIso(),
        updated_at: c.updatedAt || c.capturedAt || nowIso(),
        current_leaf_message_uuid: c.leafUuid || null,
        settings: { preview_feature_uses_artifacts: true, enabled_web_search: true },
        is_starred: false,
        is_archived: false,
        is_temporary: false,
        is_multiplayer: false,
        is_wiggle_enabled: false,
        workspace_upgraded: false,
        offers_allowed: true,
        platform: 'CLAUDE_AI',
        project: null,
        project_uuid: null,
        _forma_archived: true,
        _forma_email: c.email || null,
        _forma_msg_count: Number(c.messageCount || 0),
      });
    }
    if (excluded.length > 0) {
      log('[archive] sidebar exclusions', {
        indexCount: (index.items || []).length,
        returned: out.length,
        excludedCount: excluded.length,
        reasons: excluded.slice(0, 10),
      });
    }
    const start = Math.max(0, Number(offset) || 0);
    const lim = Number(limit) || 0;
    return lim > 0 ? out.slice(start, start + lim) : out.slice(start);
  }

  async function rename(uuid, name) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uuid))) return null;
    const clean = String(name || '').trim().slice(0, 200);
    if (!clean) return null;
    const convFile = path.join(convDir, `${uuid}.json`);
    const conv = await readConvJson(convFile, null);
    if (conv) {
      conv.name = clean;
      conv.updatedAt = nowIso();
      await writeConvJsonAtomic(convFile, conv);
    }
    const rawFile = path.join(rawDir, `${uuid}.json`);
    const raw = await readConvJson(rawFile, null);
    if (raw) {
      raw.name = clean;
      raw.updated_at = nowIso();
      await writeConvJsonAtomic(rawFile, raw);
    }
    await rebuildIndex().catch(() => {});
    return raw || conv;
  }

  async function getAlias(orgUuid, oldUuid) {
    const map = (await readJson(aliasesPath, null)) || {};
    if (orgUuid === '*' && oldUuid === '*') {
      const targets = [];
      const rootByTarget = {};
      for (const [k, v] of Object.entries(map)) {
        if (!v || !v.newUuid) continue;
        const targetId = String(v.newUuid);
        targets.push(targetId);
        const idx = k.indexOf(':');
        if (idx >= 0) rootByTarget[targetId.toLowerCase()] = k.slice(idx + 1);
      }
      return { targets, rootByTarget };
    }
    return map[`${orgUuid}:${oldUuid}`] || null;
  }

  async function setAlias(orgUuid, oldUuid, newUuid) {
    const map = (await readJson(aliasesPath, null)) || {};
    map[`${orgUuid}:${oldUuid}`] = { newUuid, at: nowIso() };
    await writeJsonAtomic(aliasesPath, map);
    return map[`${orgUuid}:${oldUuid}`];
  }

  async function remove(uuid) {
    if (!/^[a-f0-9-]{36}$/i.test(String(uuid))) throw new Error('invalid conversation id');
    const targetLower = String(uuid).toLowerCase();
    const map = (await readJson(aliasesPath, null)) || {};
    let mapChanged = false;
    for (const [k, v] of Object.entries(map)) {
      const idx = k.indexOf(':');
      const oldId = idx >= 0 ? k.slice(idx + 1).toLowerCase() : '';
      const newId = v?.newUuid ? String(v.newUuid).toLowerCase() : '';
      if (oldId === targetLower || newId === targetLower) {
        delete map[k];
        mapChanged = true;
      }
    }
    if (mapChanged) await writeJsonAtomic(aliasesPath, map).catch(() => {});
    await fsp.unlink(path.join(convDir, `${uuid}.json`)).catch(() => {});
    await fsp.unlink(path.join(rawDir, `${uuid}.json`)).catch(() => {});
    return rebuildIndex();
  }

  async function stats() {
    const index = await readIndexCached().catch(() => null);
    const failures = await readJson(failPath, null);
    const snapshot = await readJson(snapshotPath, null);
    return {
      rev: index?.rev || 0,
      conversations: index?.conversations || 0,
      messages: index?.messages || 0,
      updatedAt: index?.updatedAt || null,
      pendingRetries: failures?.items?.length || 0,
      lastSnapshot: snapshot,
      encryptedAtRest: canEncryptAtRest(),
      dir: base,
    };
  }

  return {
    capture,
    captureBarrier,
    captureQuiet,
    captureOnQuit,
    list,
    listIndex,
    get,
    saveRaw,
    getRaw,
    listForSidebar,
    rename,
    getAlias,
    setAlias,
    getAliasMap,
    remove,
    stats,
    rebuildIndex,
    replayJournal,
    mergeConversation,
  };
}

module.exports = { createChatStore, messageText, mergeConversation, normaliseConversation, slug, parseTs };
