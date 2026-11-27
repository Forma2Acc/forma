"use strict";

/**
 * forma-reset — main process module for Claude Desktop.
 *
 * Responsibilities
 *  - Temp-mail provider adapters (mail.tm, mail.gw, tempmail.plus, 1secmail, custom)
 *  - Claude account creation: send_magic_link -> poll -> verify_magic_link -> sessionKey
 *  - Session injection into the default Electron session (claude.ai cookie jar)
 *  - Account pool (pre-warmed accounts so a reset is instant)
 *  - Conversation archiver (captures chats before the account switches)
 *  - IPC surface for the renderer overlay
 *
 * All network work happens here; the renderer never touches credentials directly.
 */

const { app, ipcMain, session, safeStorage, webContents, BrowserWindow, WebContentsView } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = fs.promises;
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

// Forma Claude core: license, chat store, updater, lock. Loaded defensively —
// a broken optional module must never stop the app from starting.
let installFormaClaude = null;
let formaModuleError = null;
try {
  ({ installFormaClaude } = require("./forma-main.cjs"));
} catch (err) {
  formaModuleError = String((err && err.message) || err);
}
let createAgentController = null;
let formaAgentError = null;
try {
  ({ createAgentController } = require("./forma-agent.cjs"));
} catch (err) {
  formaAgentError = String((err && err.message) || err);
}
let forma = null;

const CH = {
  getConfig: "forma:reset:get-config",
  setConfig: "forma:reset:set-config",
  run: "forma:reset:run",
  cancel: "forma:reset:cancel",
  status: "forma:reset:status",
  pool: "forma:reset:pool",
  poolCreate: "forma:reset:pool-create",
  poolDrop: "forma:reset:pool-drop",
  archiveList: "forma:reset:archive-list",
  archiveGet: "forma:reset:archive-get",
  archiveCapture: "forma:reset:archive-capture",
  archiveDelete: "forma:reset:archive-delete",
  localChatsList: "forma:reset:local-chats-list",
  localChatGet: "forma:reset:local-chat-get",
  localChatSave: "forma:reset:local-chat-save",
  localChatAliasGet: "forma:reset:local-chat-alias-get",
  localChatAliasSet: "forma:reset:local-chat-alias-set",
  localChatRename: "forma:reset:local-chat-rename",
  localChatDelete: "forma:reset:local-chat-delete",
  clientLog: "forma:reset:client-log",
  injectMain: "forma:reset:inject-main",
  sessionInfo: "forma:reset:session-info",
  warp: "forma:reset:warp",
  warpRotate: "forma:reset:warp-rotate",
  openExternal: "forma:reset:open-external",
  event: "forma:reset:event",
  agentState: "forma:agent:state",
  agentSetConfig: "forma:agent:set-config",
  agentPickWorkspace: "forma:agent:pick-workspace",
  agentOpenWorkspace: "forma:agent:open-workspace",
  agentPromptHeader: "forma:agent:prompt-header",
  agentExec: "forma:agent:exec",
  agentStop: "forma:agent:stop",
  agentResetShell: "forma:agent:reset-shell",
  agentSkillCreate: "forma:agent:skill-create",
  agentSkillActivate: "forma:agent:skill-activate",
  agentSkillRemove: "forma:agent:skill-remove",
  agentMcpUpsert: "forma:agent:mcp-upsert",
  agentMcpConnect: "forma:agent:mcp-connect",
  agentMcpRemove: "forma:agent:mcp-remove",
  agentTree: "forma:agent:tree",
  agentReadPreview: "forma:agent:read-preview",
  agentEvent: "forma:agent:event",
};

const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LIMITS = {
  pollTimeoutMs: 180_000,
  pollIntervalMs: 700,
  archiveConcurrency: 4,
  archiveMaxConversations: 800,
  archiveMaxBytes: 64 * 1024 * 1024,
  poolMax: 8,
};

// ---------------------------------------------------------------------------
// state + storage
// ---------------------------------------------------------------------------

let rootDir = null;
let cfg = null;
let running = null; // { id, cancelled, controller }
let log = () => {};
let fallbackStore = null;
let agentCtrl = null;

function sendAgentEvent(channel, data) {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (!wc.isDestroyed()) wc.send(channel, data);
    } catch {}
  }
}

function getAgent() {
  if (!agentCtrl && rootDir && createAgentController) {
    agentCtrl = createAgentController({
      rootDir,
      electron: require("electron"),
      sendEvent: sendAgentEvent,
      log,
    });
  }
  return agentCtrl;
}

function getStore() {
  if (forma?.store) return forma.store;
  if (!fallbackStore && rootDir) {
    try {
      const { createChatStore } = require("./forma-chat-store.cjs");
      fallbackStore = createChatStore({
        rootDir,
        getSessionKey: currentSessionKey,
        getAccounts: readAccounts,
        safeStorage,
        log,
      });
    } catch {}
  }
  return fallbackStore;
}

const DEFAULT_CONFIG = {
  provider: "specter",
  fastestProvider: "specter",
  apiKey: "",
  customBaseUrl: "",
  autoCapture: true,
  autoSwitch: true,
  poolTarget: 1,
  pollTimeoutSec: 180,
  keepHistory: 0,
  nameSeq: 0,
  currentEmail: "",
  useWarp: true,
};

function nowIso() {
  return new Date().toISOString();
}

function initPaths() {
  rootDir = path.join(app.getPath("userData"), "forma-reset");
  fs.mkdirSync(path.join(rootDir, "archive"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "logs"), { recursive: true });
}

function configPath() {
  return path.join(rootDir, "config.json");
}

function poolPath() {
  return path.join(rootDir, "pool.json");
}

function accountsPath() {
  return path.join(rootDir, "accounts.json");
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

function loadConfigSync() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, headers: res.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Never let a single Electron call stall the whole run. A destroyed or busy
 * webContents can leave executeJavaScript pending forever, which used to freeze
 * the reset at an arbitrary percentage.
 */
function withTimeout(promise, ms, label, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      log(`[timeout] ${label} after ${ms}ms`);
      finish(fallback);
    }, ms);
    Promise.resolve(promise).then(
      (value) => finish(value),
      (err) => {
        log(`[timeout] ${label} rejected`, err?.message || String(err));
        finish(fallback);
      },
    );
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(Object.assign(new Error("cancelled"), { code: "ECANCEL" }));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// temp mail providers
// ---------------------------------------------------------------------------

const PROVIDERS = {
  specter: { kind: "specter", base: "https://specter.email", needsKey: false },
  "temp-mail.io": { kind: "tempmailio", base: "https://api.internal.temp-mail.io/api/v3", needsKey: false },
  "tempmail.lol": { kind: "tempmailLol", base: "https://api.tempmail.lol", needsKey: false },
  "mail.tm": { kind: "mailtm", base: "https://api.mail.tm", needsKey: false },
  "mail.gw": { kind: "mailtm", base: "https://api.mail.gw", needsKey: false },
  custom: { kind: "custom", base: "", needsKey: true },
};

function providerDef(name) {
  return PROVIDERS[name] || PROVIDERS["mail.tm"];
}

function randomLocalPart() {
  const a = "abcdefghijkmnpqrstuvwxyz";
  const n = "23456789";
  let s = "";
  for (let i = 0; i < 10; i += 1) s += a[crypto.randomInt(a.length)];
  for (let i = 0; i < 4; i += 1) s += n[crypto.randomInt(n.length)];
  return `fr${s}`;
}

function randomPassword() {
  return `Fr!${crypto.randomBytes(12).toString("base64url")}`;
}

/** mail.tm / mail.gw — same hydra API shape. */
const mailtmAdapter = {
  async create(base, signal) {
    let list = [];
    for (let attempt = 0; attempt < 3 && !list.length; attempt += 1) {
      if (attempt) await sleep(1200 * attempt, signal);
      const domains = await httpJson(`${base}/domains`, { timeoutMs: 20_000 });
      if (!domains.ok || !domains.json) {
        if (domains.status === 429) continue;
        throw new Error(`domains lookup failed (${domains.status})`);
      }
      list = Array.isArray(domains.json)
        ? domains.json
        : domains.json["hydra:member"] || domains.json["member"] || [];
      list = list.filter((d) => d && d.domain && d.isActive !== false && d.isPrivate !== true);
    }
    if (!list.length) throw new Error("no active domain available (provider busy)");
    const domain = list[crypto.randomInt(list.length)].domain;
    const address = `${randomLocalPart()}@${domain}`;
    const password = randomPassword();
    const created = await httpJson(`${base}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { address, password },
      timeoutMs: 25_000,
    });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`account create failed (${created.status})`);
    }
    const tok = await httpJson(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { address, password },
      timeoutMs: 25_000,
    });
    if (!tok.ok || !tok.json?.token) throw new Error(`token failed (${tok.status})`);
    return { address, password, token: tok.json.token };
  },

  async messages(base, box, signal) {
    const res = await httpJson(`${base}/messages`, {
      headers: { authorization: `Bearer ${box.token}` },
      timeoutMs: 20_000,
    });
    if (!res.ok || !res.json) return [];
    const members = Array.isArray(res.json) ? res.json : res.json["hydra:member"] || res.json.member || [];
    return members.map((m) => ({
      id: m.id,
      from: m.from?.address || "",
      subject: m.subject || "",
      intro: m.intro || "",
    }));
  },

  async read(base, box, id, signal) {
    const res = await httpJson(`${base}/messages/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${box.token}` },
      timeoutMs: 20_000,
    });
    if (!res.ok || !res.json) return null;
    const html = Array.isArray(res.json.html) ? res.json.html.join("\n") : res.json.html || "";
    return { subject: res.json.subject || "", text: res.json.text || "", html };
  },
};

/** temp-mail.io — one call creates the inbox, messages come back with bodies inline. */
const tempMailIoAdapter = {
  async create(base) {
    const res = await httpJson(`${base}/email/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { min_name_length: 8, max_name_length: 12 },
      timeoutMs: 20_000,
    });
    if (!res.ok || !res.json?.email) throw new Error(`temp-mail.io inbox failed (${res.status})`);
    return { address: res.json.email, password: "", token: res.json.token || "" };
  },
  async messages(base, box) {
    const res = await httpJson(`${base}/email/${box.address}/messages`, { timeoutMs: 20_000 });
    if (!res.ok || !Array.isArray(res.json)) return [];
    return res.json.map((m) => ({
      id: String(m.id),
      from: m.from || "",
      subject: m.subject || "",
      intro: String(m.body_text || "").slice(0, 200),
    }));
  },
  async read(base, box, id) {
    const res = await httpJson(`${base}/email/${box.address}/messages`, { timeoutMs: 20_000 });
    if (!res.ok || !Array.isArray(res.json)) return null;
    const hit = res.json.find((m) => String(m.id) === String(id));
    if (!hit) return null;
    return { subject: hit.subject || "", text: hit.body_text || "", html: hit.body_html || "" };
  },
};

/**
 * specter.email — the site has no public API, but its own client calls a small
 * anonymous JSON API. A random session token owns one rotating inbox, and a new
 * POST simply rotates it to a fresh address, which is exactly what a reset needs.
 */
const specterAdapter = {
  async create(base) {
    const session = crypto.randomUUID();
    const res = await httpJson(`${base}/api/emails/anonymous`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { session_token: session },
      timeoutMs: 20_000,
    });
    if (!res.ok || !res.json?.address) {
      const detail = res.json?.error || res.json?.message || res.text.slice(0, 120);
      throw new Error(`specter inbox failed (${res.status}${detail ? `: ${detail}` : ""})`);
    }
    return { address: res.json.address, password: "", token: session };
  },
  async messages(base, box) {
    const res = await httpJson(
      `${base}/api/emails/anonymous/messages?session_token=${encodeURIComponent(box.token)}`,
      { timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return [];
    return (res.json.messages || []).map((m) => ({
      id: String(m.id),
      from: m.fromAddress || "",
      subject: m.subject || "",
      intro: String(m.content || "").slice(0, 200),
    }));
  },
  async read(base, box, id) {
    const res = await httpJson(
      `${base}/api/emails/anonymous/messages/${encodeURIComponent(id)}?session_token=${encodeURIComponent(box.token)}`,
      { timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return null;
    const m = res.json.message || res.json;
    return { subject: m.subject || "", text: m.content || "", html: m.html || "" };
  },
};

/** tempmail.plus - public JSON endpoints, optional merchant key in query. */
const tempmailPlusAdapter = {
  async create(base, signal, apiKey) {
    const domain = "mailto.plus";
    const address = `${randomLocalPart()}@${domain}`;
    const q = new URLSearchParams({ email: address });
    if (apiKey) q.set("epin", apiKey);
    const res = await httpJson(`${base}/mailbox?${q}`, { timeoutMs: 20_000 });
    if (!res.ok) throw new Error(`mailbox init failed (${res.status})`);
    return { address, password: "", token: apiKey || "", domain };
  },
  async messages(base, box, signal) {
    const q = new URLSearchParams({ email: box.address, email_id: "0", limit: "20" });
    if (box.token) q.set("epin", box.token);
    const res = await httpJson(`${base}/mails?${q}`, { timeoutMs: 20_000 });
    if (!res.ok || !res.json) return [];
    const list = res.json.mail_list || res.json.mails || [];
    return list.map((m) => ({
      id: String(m.mail_id ?? m.id),
      from: m.from_mail || m.from || "",
      subject: m.subject || "",
      intro: m.text || "",
    }));
  },
  async read(base, box, id) {
    const q = new URLSearchParams({ email: box.address, mail_id: id });
    if (box.token) q.set("epin", box.token);
    const res = await httpJson(`${base}/mails/${id}?${q}`, { timeoutMs: 20_000 });
    if (!res.ok || !res.json) return null;
    return {
      subject: res.json.subject || "",
      text: res.json.text || "",
      html: res.json.html || "",
    };
  },
};

/** tempmail.lol — token-based, returns the full body inline. */
const tempmailLolAdapter = {
  async create(base, signal, apiKey) {
    const res = await httpJson(`${base.replace(/\/$/, "")}/v2/inbox/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: apiKey ? { domain: null, prefix: null } : {},
      timeoutMs: 25_000,
    });
    if (!res.ok || !res.json?.address || !res.json?.token) {
      throw new Error(`tempmail.lol inbox failed (${res.status})`);
    }
    return { address: res.json.address, password: "", token: res.json.token };
  },
  async messages(base, box, signal) {
    const res = await httpJson(
      `${base.replace(/\/$/, "")}/v2/inbox?token=${encodeURIComponent(box.token)}`,
      { timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return [];
    const list = res.json.emails || [];
    return list.map((m) => ({
      id: String(m.id ?? m.date ?? Math.random()),
      from: m.from || "",
      subject: m.subject || "",
      intro: m.body || "",
    }));
  },
  async read(base, box, id) {
    const res = await httpJson(
      `${base.replace(/\/$/, "")}/v2/inbox?token=${encodeURIComponent(box.token)}`,
      { timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return null;
    const hit = (res.json.emails || []).find((m) => String(m.id ?? m.date) === String(id));
    if (!hit) return null;
    return { subject: hit.subject || "", text: hit.body || "", html: hit.html || "" };
  },
};

/** guerrillamail — session-token API, plain text bodies. */
const guerrillaAdapter = {
  async create(base) {
    const res = await httpJson(`${base}?f=get_email_address&lang=en`, { timeoutMs: 25_000 });
    if (!res.ok || !res.json?.email_addr) throw new Error(`guerrilla inbox failed (${res.status})`);
    return { address: res.json.email_addr, password: "", token: res.json.sid_token };
  },
  async messages(base, box) {
    const res = await httpJson(
      `${base}?f=check_email&seq=0&sid_token=${encodeURIComponent(box.token)}`,
      { timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return [];
    return (res.json.list || []).map((m) => ({
      id: String(m.mail_id),
      from: m.mail_from || "",
      subject: m.mail_subject || "",
      intro: "",
    }));
  },
  async read(base, box, id) {
    const res = await httpJson(
      `${base}?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(box.token)}`,
      { timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return null;
    return {
      subject: res.json.mail_subject || "",
      text: res.json.mail_body || "",
      html: res.json.mail_body || "",
    };
  },
};

/**
 * Custom adapter — for a paid/keyed temp-mail service.
 * Contract: POST {base}/inbox -> { address, token } ; GET {base}/inbox/messages ; GET {base}/inbox/messages/:id
 * Sends the key as `Authorization: Bearer <key>` and `X-Api-Key: <key>`.
 */
const customAdapter = {
  async create(base, signal, apiKey) {
    const res = await httpJson(`${base.replace(/\/$/, "")}/inbox`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
      },
      body: {},
      timeoutMs: 25_000,
    });
    if (!res.ok || !res.json?.address) throw new Error(`custom inbox failed (${res.status})`);
    return {
      address: res.json.address,
      password: res.json.password || "",
      token: res.json.token || apiKey,
    };
  },
  async messages(base, box) {
    const res = await httpJson(`${base.replace(/\/$/, "")}/inbox/messages`, {
      headers: { authorization: `Bearer ${box.token}`, "x-api-key": box.token },
      timeoutMs: 20_000,
    });
    if (!res.ok || !res.json) return [];
    const list = res.json.messages || res.json.data || [];
    return list.map((m) => ({
      id: String(m.id ?? m.messageId),
      from: m.from || "",
      subject: m.subject || "",
      intro: m.preview || m.text || "",
    }));
  },
  async read(base, box, id) {
    const res = await httpJson(
      `${base.replace(/\/$/, "")}/inbox/messages/${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${box.token}`, "x-api-key": box.token }, timeoutMs: 20_000 },
    );
    if (!res.ok || !res.json) return null;
    return {
      subject: res.json.subject || "",
      text: res.json.text || "",
      html: res.json.html || res.json.body || "",
    };
  },
};

function adapterFor(name) {
  switch (providerDef(name).kind) {
    case "mailtm":
      return mailtmAdapter;
    case "tempmailplus":
      return tempmailPlusAdapter;
    case "tempmailLol":
      return tempmailLolAdapter;
    case "tempmailio":
      return tempMailIoAdapter;
    case "specter":
      return specterAdapter;
    case "guerrilla":
      return guerrillaAdapter;
    case "custom":
      return customAdapter;
    default:
      return tempmailLolAdapter;
  }
}

/**
 * Providers are grouped in two tiers. The first tier is asked immediately;
 * the second only joins if the first has not answered within a moment. That
 * keeps the common case fast while still surviving a provider outage, and it
 * prefers domains that Claude actually accepts.
 */
const PROVIDER_TIER1 = ["specter", "temp-mail.io", "tempmail.lol", "custom"];
const PROVIDER_TIER2 = ["mail.tm", "mail.gw"];

function mailboxCandidates() {
  const order = [];
  const push = (name) => {
    if (name && PROVIDERS[name] && !order.includes(name)) order.push(name);
  };
  push(cfg.provider);
  push(cfg.fastestProvider);
  PROVIDER_TIER1.forEach(push);
  PROVIDER_TIER2.forEach(push);

  return order
    .map((name) => {
      const def = providerDef(name);
      const base = def.kind === "custom" ? (cfg.customBaseUrl || "").trim() : def.base;
      const tier = PROVIDER_TIER2.includes(name) ? 1 : 0;
      return { name, def, base, tier };
    })
    .filter((c) => !(c.def.kind === "custom" && !c.base));
}

async function createMailbox(signal, opts = {}) {
  const candidates = mailboxCandidates();
  if (!candidates.length) throw new Error("no usable temp-mail provider configured");

  // The configured provider is authoritative — the user picked it on purpose.
  // Only when it fails do the others get a chance, in parallel, so a single
  // dead service can never block a reset.
  const primaryName = opts.force || cfg.provider;
  const primary = candidates.find((c) => c.name === primaryName) || null;
  const rest = candidates.filter((c) => c !== primary);

  if (primary) {
    const t0 = Date.now();
    try {
      const box = await adapterFor(primary.name).create(primary.base, signal, cfg.apiKey);
      if (!box || !box.address) throw new Error("provider returned no address");
      log("mailbox", { provider: primary.name, ms: Date.now() - t0, primary: true });
      return { ...box, provider: primary.name, base: primary.base };
    } catch (err) {
      log("mailbox primary failed", { provider: primary.name, error: err?.message || String(err) });
    }
  }

  if (!rest.length) throw new Error(`no mailbox available — ${primaryName} failed`);

  const t0 = Date.now();
  const winner = await new Promise((resolve, reject) => {
    let settled = false;
    let launched = 0;
    let failed = 0;
    const failures = [];
    let timer = null;

    const launch = (c) => {
      launched += 1;
      adapterFor(c.name)
        .create(c.base, signal, cfg.apiKey)
        .then((box) => {
          if (!box || !box.address) throw new Error("provider returned no address");
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ name: c.name, ms: Date.now() - t0, box: { ...box, provider: c.name, base: c.base } });
        })
        .catch((err) => {
          failed += 1;
          failures.push(`${c.name}: ${err?.message || err}`);
          if (!settled && failed >= rest.length) {
            reject(new Error(`no mailbox available — ${failures.join("; ")}`));
          }
        });
    };

    rest.filter((c) => c.tier === 0).forEach(launch);
    timer = setTimeout(() => {
      if (settled) return;
      rest.filter((c) => c.tier === 1).forEach(launch);
      if (!launched) reject(new Error("no temp-mail provider configured"));
    }, 1500);
  });

  log("mailbox", { provider: winner.name, ms: winner.ms, fallback: true });
  return winner.box;
}

/** Times each provider's inbox creation. Used by the self-test. */
async function benchProviders() {
  const out = {};
  for (const c of mailboxCandidates()) {
    const t0 = Date.now();
    try {
      const box = await adapterFor(c.name).create(c.base, undefined, cfg.apiKey);
      out[c.name] = { ok: !!(box && box.address), ms: Date.now() - t0, tier: c.tier };
    } catch (err) {
      out[c.name] = { ok: false, ms: Date.now() - t0, tier: c.tier, error: err?.message || String(err) };
    }
  }
  const usable = Object.entries(out).filter(([, v]) => v.ok);
  const best =
    usable.filter(([, v]) => v.tier === 0).sort((a, b) => a[1].ms - b[1].ms)[0] ||
    usable.sort((a, b) => a[1].ms - b[1].ms)[0];
  if (best) {
    cfg.fastestProvider = best[0];
    writeJson(configPath(), cfg).catch(() => {});
  }
  return { results: out, fastest: best?.[0] || null };
}

// ---------------------------------------------------------------------------
// cloudflare warp
//
// WARP is usually installed in "WarpProxy" mode: a local HTTP proxy on
// 127.0.0.1:40000 that does not touch system routing. The signup therefore just
// uses that proxy, so claude.ai sees a Cloudflare egress address instead of the
// home connection, and nothing else on the machine changes. If WARP is missing
// or not running, everything silently goes direct.
// ---------------------------------------------------------------------------

const WARP_CLI = "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe";

let warpState = { checkedAt: 0, available: false, connected: false, port: 40000 };

function runWarpCli(args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WARP_CLI)) return resolve({ ok: false, out: "", error: "not installed" });
    execFile(WARP_CLI, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      resolve({ ok: !err, out, error: err ? err.message : "" });
    });
  });
}

async function warpRefresh() {
  const res = await runWarpCli(["status"], 12_000);
  const settings = await runWarpCli(["settings"], 12_000);
  const portMatch = /WarpProxy on port (\d+)/i.exec(settings.out || "");
  warpState = {
    checkedAt: Date.now(),
    available: fs.existsSync(WARP_CLI),
    connected: /Connected/i.test(res.out) && !/Disconnected/i.test(res.out),
    port: portMatch ? Number(portMatch[1]) : warpState.port || 40000,
  };
  return warpState;
}

async function warpStatus(force = false) {
  if (force || Date.now() - warpState.checkedAt > 30_000) await warpRefresh();
  return warpState;
}

async function warpEnsureConnected() {
  const st = await warpStatus(true);
  if (!st.available) return { ok: false, reason: "not installed" };
  if (st.connected) return { ok: true, connected: true, port: st.port };
  const res = await runWarpCli(["connect"], 25_000);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const now = await warpStatus(true);
    if (now.connected) return { ok: true, connected: true, port: now.port };
    await sleep(800);
  }
  return { ok: false, reason: res.out.trim().slice(0, 120) };
}

/** Reconnects WARP and reports the egress address before and after. */
async function warpRotate() {
  const before = await proxiedIp();
  await runWarpCli(["disconnect"], 20_000);
  await sleep(1200);
  await runWarpCli(["connect"], 25_000);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const now = await warpStatus(true);
    if (now.connected) break;
    await sleep(700);
  }
  await sleep(900);
  const after = await proxiedIp();
  const rotated = !!before && !!after && before !== after;
  log("[warp] rotate", { before, after, rotated });
  return { ok: true, before, after, rotated };
}

function warpProxyRules() {
  const port = warpState.port || 40000;
  return `http=127.0.0.1:${port};https=127.0.0.1:${port}`;
}

/** Points a session at the WARP proxy. Returns false when WARP is unusable. */
async function applyWarpProxy(ses) {
  const st = await warpStatus();
  if (!st.available) return false;
  try {
    await ses.setProxy({ proxyRules: warpProxyRules() });
    log("[warp] proxy applied", { port: st.port, connected: st.connected });
    return true;
  } catch (err) {
    log("[warp] proxy failed", { error: err?.message || String(err) });
    return false;
  }
}

/** Public egress address as seen through the WARP proxy. */
function proxiedIp() {
  const port = warpState.port || 40000;
  return new Promise((resolve) => {
    execFile(
      "curl.exe",
      ["-sS", "--max-time", "12", "-x", `http://127.0.0.1:${port}`, "https://api.ipify.org"],
      { timeout: 16_000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout || "").trim() || null),
    );
  });
}

// ---------------------------------------------------------------------------
// claude account creation
// ---------------------------------------------------------------------------

const CLAUDE_HEADERS = {
  "content-type": "application/json",
  "user-agent": CLAUDE_UA,
  origin: CLAUDE_ORIGIN,
  referer: `${CLAUDE_ORIGIN}/login`,
  "anthropic-client-platform": "web_claude_ai",
};

function extractCode(blob) {
  if (!blob) return null;
  const six = blob.match(/\b(\d{6})\b/);
  if (six) return six[1];
  const spaced = blob.match(/\b(\d{3})[\s-](\d{3})\b/);
  if (spaced) return spaced[1] + spaced[2];
  return null;
}

function extractMagicLink(blob) {
  if (!blob) return null;
  const m = blob.match(/https:\/\/claude\.ai\/[^\s"'<>]*magic[^\s"'<>]*/i);
  if (m) return m[0].replace(/&amp;/g, "&");
  const alt = blob.match(/https:\/\/claude\.ai\/[^\s"'<>]*(?:nonce|login)[^\s"'<>]*/i);
  return alt ? alt[0].replace(/&amp;/g, "&") : null;
}

async function claudeSendMagicLink(email, signal) {
  const res = await httpJson(`${CLAUDE_ORIGIN}/api/auth/send_magic_link`, {
    method: "POST",
    headers: CLAUDE_HEADERS,
    body: {
      email_address: email,
      source: "claude",
      utc_offset: -new Date().getTimezoneOffset(),
    },
    timeoutMs: 25_000,
  });
  if (res.status === 429) {
    throw Object.assign(new Error("Claude is rate-limiting this IP — wait a few minutes."), {
      code: "ERATELIMIT",
    });
  }
  if (res.status === 200 || res.status === 201 || res.status === 204) return true;
  const code = res.json?.error?.details?.error_code;
  if (code === "signups_disabled") {
    throw Object.assign(
      new Error("Claude has new signups gated right now (captcha / signups_disabled)."),
      { code: "ESIGNUPS" },
    );
  }
  const detail = res.json?.error?.message || res.text.slice(0, 200);
  throw new Error(`send_magic_link failed (${res.status}): ${detail}`);
}

function readSessionKeyFrom(res) {
  const cookies = res.headers.getSetCookie?.() || [];
  for (const c of cookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if ((name === "sessionKey" || name === "sessionKeyV3") && value) return value;
  }
  return null;
}

async function claudeVerifyCode(email, code, signal) {
  const res = await httpJson(`${CLAUDE_ORIGIN}/api/auth/verify_magic_link`, {
    method: "POST",
    headers: CLAUDE_HEADERS,
    body: {
      source: "claude",
      credentials: { method: "code", email_address: email, code },
    },
    timeoutMs: 25_000,
  });
  const key = readSessionKeyFrom(res);
  if (key) return { sessionKey: key };
  const detail = res.json?.error?.message || res.text.slice(0, 200);
  return { error: `${res.status}: ${detail}` };
}

async function claudeVerifyNonce(encodedEmail, nonce) {
  const res = await httpJson(`${CLAUDE_ORIGIN}/api/auth/verify_magic_link`, {
    method: "POST",
    headers: CLAUDE_HEADERS,
    body: {
      source: "claude",
      credentials: { method: "nonce", encoded_email_address: encodedEmail, nonce },
    },
    timeoutMs: 25_000,
  });
  const key = readSessionKeyFrom(res);
  if (key) return { sessionKey: key };
  const detail = res.json?.error?.message || res.text.slice(0, 200);
  return { error: `${res.status}: ${detail}` };
}

// ---------------------------------------------------------------------------
// account naming
// ---------------------------------------------------------------------------

/**
 * Sequential names: "forma acc 1", "forma acc 2", ...
 * The counter is recomputed from accounts.json so it never restarts at 1, even
 * when the config file is reset or the pool is pruned.
 */
function nextAccountName() {
  let highest = Number(cfg.nameSeq || 0);
  try {
    const list = JSON.parse(fs.readFileSync(accountsPath(), "utf8"));
    if (Array.isArray(list)) {
      for (const a of list) {
        const m = /^forma acc (\d+)$/.exec(String(a?.name || ""));
        if (m) highest = Math.max(highest, Number(m[1]));
      }
    }
  } catch {
    /* first account: no file yet */
  }
  const n = highest + 1;
  cfg.nameSeq = n;
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch {
    /* not fatal: the next run recomputes from accounts.json anyway */
  }
  return `forma acc ${n}`;
}

/**
 * Sets the visible account name. Claude has renamed this endpoint a few times,
 * so the candidates are tried in order until one answers 2xx.
 */
async function setAccountName(sessionKey, name) {
  // The API validates strictly: any unknown key is rejected with
  // "Extra inputs are not permitted", so only the two name fields go in.
  const body = { full_name: name, display_name: name };
  const candidates = [
    ["PUT", "/api/account"],
    ["POST", "/api/account/profile"],
    ["PATCH", "/api/account"],
  ];
  for (const [method, p] of candidates) {
    const res = await httpJson(`${CLAUDE_ORIGIN}${p}`, {
      method,
      headers: { ...CLAUDE_HEADERS, cookie: `sessionKey=${sessionKey}`, accept: "application/json" },
      body,
      timeoutMs: 15_000,
    }).catch(() => null);
    if (res && res.ok) {
      log("[name] applied", { via: `${method} ${p}`, name });
      return { ok: true, via: `${method} ${p}` };
    }
    log("[name] rejected", {
      via: `${method} ${p}`,
      status: res ? res.status : "network",
      body: res ? String(res.text || "").replace(/\s+/g, " ").slice(0, 220) : "",
    });
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// onboarding
// ---------------------------------------------------------------------------

/**
 * A brand new account is dropped on /onboarding. Instead of clicking through
 * the tutorial, the two flags the client reads on boot are set server-side —
 * the same values a finished tutorial would leave behind.
 */
async function skipOnboarding(sessionKey) {
  const body = {
    has_started_claudeai_onboarding: true,
    has_finished_claudeai_onboarding: true,
    has_seen_starter_prompts: true,
    has_seen_mm_examples: true,
  };
  // PATCH is the only accepted verb (GET/POST/PUT answer 405) and it replies 202
  // with the merged settings, so the response itself is the verification.
  const res = await httpJson(`${CLAUDE_ORIGIN}/api/account/settings`, {
    method: "PATCH",
    headers: { ...CLAUDE_HEADERS, cookie: `sessionKey=${sessionKey}`, accept: "application/json" },
    body,
    timeoutMs: 15_000,
  }).catch(() => null);
  const flags = res?.json || {};
  const finished = flags.has_finished_claudeai_onboarding === true;
  log("[onboard] flags", {
    status: res ? res.status : "network",
    finished,
  });
  return finished;
}

/**
 * Fallback: the desktop client drops a fresh account on a multi-step tutorial
 * (birthday, usage type, plan, first-chat notice, role). This drives every one
 * of those screens, including the date input and the combobox, until the chat
 * composer appears.
 */
const JS_ONBOARD_STEP = `(() => {
  const vis = (n) => {
    const r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(n);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const label = (n) => norm(n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "");
  const enabled = (n) =>
    !n.disabled && n.getAttribute("aria-disabled") !== "true" && n.getAttribute("aria-busy") !== "true";

  const setValue = (input, value) => {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // 1. Birthday screen: a date field that has to be filled before "Weiter".
  const dateish = Array.from(document.querySelectorAll("input")).filter(vis).find((i) => {
    const hint = (i.placeholder || "") + " " + (i.name || "") + " " + (i.id || "") + " " + (i.type || "");
    return /tt\\.?mm|dd\\.?mm|mm\\/dd|geburt|birth|date/i.test(hint);
  });
  if (dateish && !String(dateish.value || "").trim()) {
    const nativePicker = dateish.type === "date";
    setValue(dateish, nativePicker ? "1995-01-01" : "01.01.1995");
    dateish.dispatchEvent(new Event("blur", { bubbles: true }));
    return "date:01.01.1995";
  }

  // 2. A combobox that must have a choice before continuing.
  const combo = Array.from(document.querySelectorAll('[role="combobox"], select')).filter(vis)[0];
  if (combo && document.body.innerText && /bereich|rolle|role|field/i.test(document.body.innerText.slice(0, 400))) {
    const later = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(vis).find((b) =>
      /sp\\u00e4ter einrichten|set up later|later|\\u00fcberspringen|skip/i.test(label(b)),
    );
    if (later && enabled(later)) {
      later.click();
      return "click:" + label(later).slice(0, 32);
    }
  }

  // 3. Explicit choices, most specific first.
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="radio"], [role="option"], label')).filter(vis);
  const prio = [
    /claude kostenlos nutzen|kostenlos nutzen|start chatting|chat starten|start free|free plan/i,
    /f\\u00fcr den pers\\u00f6nlichen gebrauch|personal use|for myself/i,
    /sp\\u00e4ter einrichten|set up later|vielleicht sp\\u00e4ter|maybe later|not now|\\u00fcberspringen|skip/i,
    /^(los geht'?s|los geht|let'?s go|jetzt starten|erste schritte|get started|start)$/i,
    /^(weiter|continue|next|fortfahren|n\\u00e4chster schritt)$/i,
    /^(fertig|finish|done|abschlie\\u00dfen|claude \\u00f6ffnen|open claude)$/i,
  ];
  for (const re of prio) {
    for (const b of nodes) {
      const t = label(b);
      if (!t || t.length > 60) continue;
      if (!enabled(b)) continue;
      if (!re.test(t)) continue;
      b.click();
      return "click:" + t.slice(0, 32);
    }
  }
  return "none";
})()`;

/** True once the chat UI is up: the tutorial is over. */
const JS_HAS_CHAT = `(() => !!document.querySelector(".ProseMirror"))()`;

async function completeOnboarding(wc, signal, emit) {
  const startedAt = Date.now();
  let steps = 0;
  let idle = 0;
  while (Date.now() - startedAt < 90_000) {
    if (signal?.aborted) return false;
    let url = "";
    try {
      url = wc.getURL();
    } catch {
      return false;
    }
    const inFlow = /onboarding|welcome|setup|login|magic/i.test(url);
    const hasChat = await withTimeout(wc.executeJavaScript(JS_HAS_CHAT, true), 4_000, "onboard-has-chat", false);
    if (!inFlow && hasChat) return true;
    if (!inFlow && !hasChat && idle > 8) return true;

    const res = await withTimeout(wc.executeJavaScript(JS_ONBOARD_STEP, true), 6_000, "onboard-step", "none");
    if (res && res !== "none") {
      steps += 1;
      idle = 0;
      log("[onboarding] step", { steps, action: res, url: url.replace(CLAUDE_ORIGIN, "").slice(0, 48) });
      emit({ pct: 88 + Math.min(8, steps), note: "onboarding" });
    } else {
      idle += 1;
      if (idle === 5) {
        // Nothing to click: some flows finish by simply navigating on.
        await withTimeout(wc.loadURL(`${CLAUDE_ORIGIN}/new`), 25_000, "onboard-new", null);
      }
      if (idle > 16) return false;
    }
    await sleep(420, signal);
  }
  return false;
}

/** The address the current session belongs to (not a cached config value). */
async function accountEmail(sessionKey) {
  const res = await httpJson(`${CLAUDE_ORIGIN}/api/account`, {
    headers: { ...CLAUDE_HEADERS, cookie: `sessionKey=${sessionKey}`, accept: "application/json" },
    timeoutMs: 15_000,
  }).catch(() => null);
  return res?.json?.email_address || "";
}

async function claudeAccountInfo(sessionKey) {  const res = await httpJson(`${CLAUDE_ORIGIN}/api/organizations`, {
    headers: {
      accept: "application/json",
      "user-agent": CLAUDE_UA,
      "anthropic-client-platform": "web_claude_ai",
      cookie: `sessionKey=${sessionKey}`,
    },
    timeoutMs: 20_000,
  });
  if (!res.ok || !Array.isArray(res.json)) return { ok: false, status: res.status, orgs: [] };
  return { ok: true, status: res.status, orgs: res.json };
}

// ---------------------------------------------------------------------------
// headless sign-in
//
// Claude gates account creation behind a client attestation token produced by
// their own page JavaScript, so the raw HTTP endpoint answers 400
// missing_client_attestation. The fix is to run the real login page inside a
// window that is never shown. It shares the app's cookie jar, so the
// sessionKey it obtains is the same cookie the app already reads.
// ---------------------------------------------------------------------------

const PAGE_PROBE_JS = `(() => {
  const seen = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(seen);
  const email = inputs.find(
    (el) => el.type === "email" || el.name === "email" || /email/i.test(el.id || "") || /email/i.test(el.name || ""),
  );
  const boxes = inputs.filter((el) => el.maxLength === 1);
  const code =
    inputs.find(
      (el) =>
        el.autocomplete === "one-time-code" ||
        /code/i.test(el.name || "") ||
        /code/i.test(el.id || "") ||
        el.inputMode === "numeric",
    ) || null;
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
    .filter(seen)
    .map((b) => (b.textContent || "").trim().replace(/\\s+/g, " "))
    .filter((t) => t && t.length < 48);
  return {
    url: location.pathname,
    hasEmail: !!email,
    hasCode: !!code || boxes.length >= 4,
    codeBoxes: boxes.length,
    buttons: buttons.slice(0, 14),
    fields: inputs.slice(0, 8).map((i) => ({
      t: i.type,
      n: i.name || "",
      id: i.id || "",
      ph: i.placeholder || "",
      ml: i.maxLength,
      v: String(i.value || "").slice(0, 24),
    })),
    controls: Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'))
      .filter(seen)
      .map((n) => {
        const r = n.getBoundingClientRect();
        return {
          tag: n.tagName,
          txt: String(n.tagName === "INPUT" ? n.value : n.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 32),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          dis: !!n.disabled,
        };
      })
      .slice(0, 20),
    body: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 400),
  };
})()`;

const JS_CLICK_TEXT = (pattern) => `(() => {
  const re = ${pattern};
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(seen);
  const hit = nodes.find((n) => re.test((n.textContent || "").trim()));
  if (!hit) return "none";
  hit.click();
  return "clicked:" + (hit.textContent || "").trim().slice(0, 40);
})()`;

const JS_FILL_EMAIL = (email) => `(() => {
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(seen);
  const el =
    inputs.find((i) => i.type === "email") ||
    inputs.find((i) => i.name === "email") ||
    inputs.find((i) => /email/i.test(i.id || ""));
  if (!el) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(email)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
  return "filled";
})()`;

const JS_SUBMIT = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const label = (n) =>
    (n.tagName === "INPUT" ? n.value || "" : n.textContent || "").trim().replace(/\\s+/g, " ");
  const cands = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'))
    .filter(vis)
    .filter((n) => !n.disabled);
  // A container that also offers SSO / social login is not the email button.
  const score = (n) => {
    const t = label(n).toLowerCase();
    if (!t) return 99;
    if (/sso|single sign|google|microsoft|apple|passkey|magic link|github/.test(t)) return 99;
    let s = 60;
    if (/e-?mail/.test(t)) s -= 12;
    if (/fortfahren|weiter|continue|next|submit|verify|confirm|anmelden|sign in|log in|senden|send/.test(t)) s -= 18;
    if (n.type === "submit") s -= 14;
    s += Math.min(18, t.length / 5);
    return s;
  };
  cands.sort((a, b) => score(a) - score(b));
  const hit = cands[0];
  if (!hit || score(hit) >= 50) return "none";
  hit.click();
  return "clicked:" + label(hit).slice(0, 40);
})()`;

const JS_FOCUS_EMAIL = `(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(vis);
  const el =
    inputs.find((i) => i.type === "email") ||
    inputs.find((i) => i.name === "email") ||
    inputs.find((i) => /email/i.test(i.id || ""));
  if (!el) return "no-input";
  el.focus();
  const len = (el.value || "").length;
  try {
    el.setSelectionRange(len, len);
  } catch {
    /* not a text field */
  }
  return "focused";
})()`;

const JS_FILL_CODE = (code) => `(() => {
  const digits = ${JSON.stringify(code)}.split("");
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const inputs = Array.from(document.querySelectorAll("input")).filter(seen);
  const boxes = inputs.filter((el) => el.maxLength === 1);
  if (boxes.length >= digits.length) {
    boxes.forEach((b, idx) => {
      setter.call(b, digits[idx] || "");
      b.dispatchEvent(new Event("input", { bubbles: true }));
      b.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const last = boxes[digits.length - 1];
    if (last) last.focus();
    return "boxes:" + boxes.length;
  }
  const single =
    inputs.find((el) => el.autocomplete === "one-time-code") ||
    inputs.find((el) => /code/i.test(el.name || "") || /code/i.test(el.id || "")) ||
    inputs.find((el) => el.inputMode === "numeric");
  if (single) {
    setter.call(single, digits.join(""));
    single.dispatchEvent(new Event("input", { bubbles: true }));
    single.dispatchEvent(new Event("change", { bubbles: true }));
    return "single";
  }
  return "no-input";
})()`;

const JS_POINT_FOR = (pattern) => `(() => {
  const re = ${pattern};
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, span, div, input[type='submit']"))
    .filter(vis)
    .filter((n) => re.test(String(n.tagName === "INPUT" ? n.value : n.textContent || "").trim()));
  if (!nodes.length) return null;
  const area = (n) => {
    const r = n.getBoundingClientRect();
    return r.width * r.height;
  };
  nodes.sort((a, b) => area(a) - area(b));
  const n = nodes[0];
  const r = n.getBoundingClientRect();
  // Bias to the left third: combined controls put the primary label first.
  const x = Math.round(r.x + Math.min(r.width / 2, 40));
  const y = Math.round(r.y + r.height / 2);
  const under = document.elementFromPoint(x, y);
  return {
    x,
    y,
    txt: String(n.textContent || "").trim().slice(0, 40),
    tag: n.tagName,
    under: under ? under.tagName + "." + String(under.className || "").slice(0, 30) : "",
  };
})()`;

function clickAt(wc, x, y) {
  try {
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return `click@${x},${y}`;
  } catch (err) {
    return `click-failed:${err?.message || err}`;
  }
}

function attachLogging(wc, tag) {
  try {
    wc.setBackgroundThrottling(false);
  } catch {
    /* older electron */
  }
  wc.on("console-message", (_e, level, message) => {
    if (level >= 2) log(`[${tag}] console`, String(message).slice(0, 200));
  });
  wc.on("did-fail-load", (_e, code, desc) => log(`[${tag}] load-failed`, code, desc));
}

async function readSessionKeyFrom(part) {
  const list = await part.cookies.get({ name: "sessionKey" });
  return list?.[0]?.value || null;
}

async function readSessionKey() {
  const list = await claudeSession().cookies.get({ url: CLAUDE_ORIGIN, name: "sessionKey" });
  return list?.[0]?.value || null;
}

/**
 * Runs the real claude.ai login page with no visible window.
 * Resolves with a sessionKey, or throws with a readable reason.
 */
/**
 * The desktop app destroys any BrowserWindow it did not create itself, so the
 * sign-in page is hosted in a WebContentsView layered underneath the app's own
 * view inside the existing window. Nothing new appears on screen and no second
 * window exists.
 */
function hostWindow() {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return wins.find((w) => w.isVisible()) || wins[0] || null;
}

/**
 * Polls the temp mailbox until Claude's message arrives and returns both the
 * code (if the mail has one) and the magic link. Claude's current flow sends a
 * link, not a code, so the link is the primary path.
 */
async function waitForMail(adapter, box, signal, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "ECANCEL" });
    await sleep(700);
    const msgs = await adapter.messages(box.base, box).catch(() => []);
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      const body = await adapter.read(box.base, box, m.id).catch(() => null);
      if (!body) continue;
      seen.add(m.id);
      const blob = `${m.subject}\n${m.intro}\n${body.subject}\n${body.text}\n${body.html}`;
      const code = extractCode(blob);
      const link = extractMagicLink(blob);
      if (!code && !link) continue;
      log("[mail] hit", { subject: (m.subject || body.subject || "").slice(0, 80), code: code || null, link: (link || "").slice(0, 120) });
      log("[mail] blob", blob.replace(/\s+/g, " ").slice(0, 700));
      return { code, link, subject: m.subject || body.subject || "", blob };
    }
  }
  return { code: null, link: null };
}

async function signInHeadless({ email, mailPromise, codePromise, signal, emit, useWarp = cfg.useWarp }) {
  const host = hostWindow();
  if (!host) throw new Error("no host window for sign-in");

  // A throwaway in-memory partition: no leftover cookies or storage from a
  // previous signup, and the user's own session is never touched.
  const part = session.fromPartition(`forma-signin-${crypto.randomUUID()}`, { cache: false });

  // Mask the signup origin: only this throwaway session is routed through the
  // local WARP proxy. A missing or stopped WARP just means a direct connection.
  let masked = false;
  if (useWarp) {
    const warp = await withTimeout(warpEnsureConnected(), 25_000, "warp-connect", { ok: false });
    if (warp && warp.ok) masked = await applyWarpProxy(part);
    log("[signin] warp", { ok: !!(warp && warp.ok), masked });
  }
  const view = new WebContentsView({
    webPreferences: {
      session: part,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const bounds = host.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  // Index 0 keeps it behind every view the app itself added.
  host.contentView.addChildView(view, 0);

  const wc = view.webContents;
  wc.setBackgroundThrottling(false);
  log("[signin] view mounted", { w: bounds.width, h: bounds.height });
  attachLogging(wc, "signin");

  // Opt-in (debug.flag): record the JSON that claude.ai answers the signup
  // POST with. That is the only place the real error code appears. Never let
  // this block the flow — a debugger that cannot attach is just a no-op.
  if (fs.existsSync(path.join(rootDir, "debug.flag"))) {
    (async () => {
      try {
        wc.debugger.attach("1.3");
        await withTimeout(wc.debugger.sendCommand("Network.enable"), 5_000, "net-enable", null);
        log("[net] capturing");
        const interesting = new Map();
        wc.debugger.on("message", async (_e, method, params) => {
          try {
            if (method === "Network.responseReceived") {
              const { requestId, response } = params;
              const url = response.url || "";
              if (/claude\.ai\/(api|login|signup)/.test(url) && !/\.(js|css|png|svg|woff2?|ico)(\?|$)/.test(url)) {
                interesting.set(requestId, url);
              }
            } else if (method === "Network.loadingFinished") {
              const url = interesting.get(params.requestId);
              if (!url) return;
              interesting.delete(params.requestId);
              const r = await wc.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId });
              log("[net]", {
                url: url.replace(CLAUDE_ORIGIN, ""),
                body: String(r.body || "").replace(/\s+/g, " ").slice(0, 900),
              });
            }
          } catch {
            /* debugging must never break the flow */
          }
        });
      } catch (err) {
        log("[net] debugger unavailable", err?.message || String(err));
      }
    })();
  }

  let snapIndex = 0;
  const snap = async (tag) => {
    try {
      const img = await view.webContents.capturePage();
      const file = path.join(rootDir, `signin-${++snapIndex}-${tag}.png`);
      fs.writeFileSync(file, img.toPNG());
      log("[signin] snapshot", file);
    } catch (err) {
      log("[signin] snapshot failed", err?.message || String(err));
    }
  };

  let mail = null;
  let mailError = null;
  let code = null;
  const pendingMail = mailPromise || (codePromise ? codePromise.then((c) => ({ code: c, link: null })) : Promise.resolve(null));
  pendingMail.then(
    (m) => {
      mail = m || null;
      code = mail?.code || null;
      log("[signin] mail received", mail ? { code: code || null, link: (mail.link || "").slice(0, 120) } : "empty");
    },
    (err) => {
      mailError = err;
    },
  );

  const cleanup = () => {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch {
      /* not attached */
    }
    try {
      if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    } catch {
      /* host gone */
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      /* already closed */
    }
  };

  const totalMs = Math.min(150, Math.max(45, cfg.pollTimeoutSec || 180)) * 1000;
  const deadline = Date.now() + totalMs;
  const startedAt = Date.now();

  let emailSubmittedAt = 0;
  let codeSubmitted = false;
  let sawEmailForm = false;
  let cookieDismissed = false;
  let linkLoaded = false;
  let lastBody = "";
  let tick = 0;

  const urlNow = () => {
    try {
      return wc.isDestroyed() ? "destroyed" : wc.getURL().replace(CLAUDE_ORIGIN, "");
    } catch {
      return "unavailable";
    }
  };

  // Real key events are the fallback when a click lands on the wrong element.
  const pressEnter = () => {
    try {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      wc.sendInputEvent({ type: "char", keyCode: "\r" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      return "enter";
    } catch (err) {
      return `enter-failed:${err?.message || err}`;
    }
  };

  try {
    await withTimeout(wc.loadURL(`${CLAUDE_ORIGIN}/login`), 30_000, "loadURL", null);
    await sleep(1500, signal);
    await snap("loaded");

    while (Date.now() < deadline) {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "ECANCEL" });

      const key = await withTimeout(readSessionKeyFrom(part), 5_000, "readSessionKey", null);
      if (key) {
        log("[signin] session cookie present", { afterMs: Date.now() - startedAt });
        emit({ pct: 96, note: "session" });
        // A fresh account is parked on /onboarding. Set the finished-tutorial
        // flags server-side first: that costs one request and avoids clicking
        // through several screens.
        const skipped = await withTimeout(skipOnboarding(key), 20_000, "onboard-flags", false);
        await withTimeout(wc.loadURL(`${CLAUDE_ORIGIN}/new`), 30_000, "post-login", null);
        if (!skipped) {
          await sleep(1200, signal);
          const onboarded = await withTimeout(completeOnboarding(wc, signal, emit), 90_000, "onboarding", false);
          log("[signin] onboarding", { ok: onboarded, at: urlNow() });
        } else {
          const landed = await withTimeout(wc.executeJavaScript("location.pathname", true), 5_000, "post-land", "");
          log("[signin] onboarding skipped", { landed });
          if (String(landed).indexOf("onboarding") !== -1) {
            const onboarded = await withTimeout(completeOnboarding(wc, signal, emit), 60_000, "onboarding", false);
            log("[signin] onboarding fallback", { ok: onboarded, at: urlNow() });
          }
        }
        const rotated = await withTimeout(readSessionKeyFrom(part), 5_000, "readSessionKey2", null);
        return rotated || key;
      }

      // Claude emails a magic link, so following it finishes the login.
      if (mail?.link && !linkLoaded && emailSubmittedAt) {
        linkLoaded = true;
        log("[signin] following magic link", mail.link.slice(0, 140));
        emit({ pct: 84, note: "link" });
        await withTimeout(wc.loadURL(mail.link), 30_000, "magic-link", null);
        await sleep(1500, signal);
        await snap("after-link");
        continue;
      }

      const probe = await withTimeout(wc.executeJavaScript(PAGE_PROBE_JS, true), 8_000, "probe", null);
      tick += 1;
      if (tick % 6 === 0) log("[signin] tick", { tick, probe: !!probe, at: urlNow() });
      if (tick <= 2 || tick === 20) log("[signin] dom", JSON.stringify(probe).slice(0, 1500));

      if (probe) {
        if (probe.body && probe.body !== lastBody) {
          lastBody = probe.body;
          log("[signin] page", { url: probe.url, body: probe.body.slice(0, 180) });
        }
        if (probe.hasEmail) sawEmailForm = true;

        if (!emailSubmittedAt && probe.hasEmail) {
          if (!cookieDismissed) {
            const p = await withTimeout(
              wc.executeJavaScript(JS_POINT_FOR("/^akzeptieren/i"), true),
              4_000,
              "point-cookies",
              null,
            );
            if (p && p.x) {
              clickAt(wc, p.x, p.y);
              cookieDismissed = true;
              log("[signin] cookies accepted", p);
              await sleep(400, signal);
            }
          }
          const filled = await withTimeout(
            wc.executeJavaScript(JS_FILL_EMAIL(email), true),
            6_000,
            "fill-email",
            "error",
          );
          log("[signin] fill-email", filled);
          if (filled === "filled") {
            await sleep(200, signal);
            const point = await withTimeout(
              wc.executeJavaScript(JS_POINT_FOR("/e-?mail/i"), true),
              6_000,
              "point-email",
              null,
            );
            log("[signin] point-email", point);
            if (point && point.x) {
              log("[signin] submit-email", clickAt(wc, point.x, point.y));
            } else {
              log("[signin] submit-email", pressEnter());
            }
            emailSubmittedAt = Date.now();
            emit({ pct: 40, note: "submitted" });
            await sleep(2500, signal);
            await snap("after-email");
          }
        } else if (!emailSubmittedAt && !sawEmailForm) {
          const res = await withTimeout(
            wc.executeJavaScript(JS_CLICK_TEXT("/e-?mail/i"), true),
            5_000,
            "reveal-email",
            "none",
          );
          if (res !== "none") log("[signin] reveal-email", res);
        }

        if (code && !codeSubmitted && probe.hasCode) {
          const filled = await withTimeout(wc.executeJavaScript(JS_FILL_CODE(code), true), 6_000, "fill-code", "error");
          log("[signin] fill-code", filled);
          if (filled !== "no-input" && filled !== "error") {
            await sleep(250, signal);
            const point = await withTimeout(
              wc.executeJavaScript(JS_POINT_FOR("/fortfahren|continue|verify|confirm|anmelden|submit|best/i"), true),
              6_000,
              "point-code",
              null,
            );
            log("[signin] point-code", point);
            if (point && point.x) {
              log("[signin] submit-code", clickAt(wc, point.x, point.y));
            } else {
              log("[signin] submit-code", pressEnter());
            }
            codeSubmitted = true;
            emit({ pct: 88, note: "verifying" });
          }
        }

        if (/signups? (are )?(currently )?(disabled|closed)|unable to (sign|create)|too many/i.test(probe.body)) {
          throw new Error(`Claude refused the signup: ${probe.body.slice(0, 120)}`);
        }
        if (/f\u00fcr neue Nutzer nicht verf\u00fcgbar|not available for new users|new users are not/i.test(probe.body)) {
          throw Object.assign(
            new Error("Claude is not accepting new signups right now (temporary gate)"),
            { code: "EGATE" },
          );
        }
      }

      // Gentle retry if the address was accepted but the page never moved on.
      if (emailSubmittedAt && !code && Date.now() - emailSubmittedAt > 25_000 && tick % 40 === 0 && !probe?.hasCode) {
        await withTimeout(wc.executeJavaScript(JS_FOCUS_EMAIL, true), 4_000, "focus-email", "no-input");
        log("[signin] retry-submit", pressEnter());
      }

      if (mailError) throw mailError;
      await sleep(400, signal);
    }

    throw new Error("sign-in did not finish in time");
  } finally {
    cleanup();
  }
}
/**
 * Boot-time harness. Writes a flag file whose content is an optional provider
 * name; when present the full signup path runs with no UI interaction and a
 * report is written next to the flag. The current session is always restored.
 */
async function probeWindowSurvival() {
  const variants = [
    { name: "bare", opts: { width: 420, height: 320, show: false } },
    { name: "session", opts: { width: 420, height: 320, show: false, webPreferences: { session: claudeSession() } } },
    { name: "offscreen", opts: { width: 420, height: 320, show: false, webPreferences: { offscreen: true } } },
    {
      name: "shown-offscreen",
      opts: { width: 420, height: 320, x: -20000, y: -20000, show: true, skipTaskbar: true },
    },
  ];
  const out = {};
  for (const v of variants) {
    try {
      const w = new BrowserWindow(v.opts);
      await w.loadURL(`${CLAUDE_ORIGIN}/login`).catch(() => {});
      await sleep(2500);
      if (w.isDestroyed()) {
        out[v.name] = { destroyed: true };
      } else {
        out[v.name] = { destroyed: false, url: w.webContents.getURL().slice(0, 80) };
        w.destroy();
      }
    } catch (err) {
      out[v.name] = { error: err?.message || String(err) };
    }
  }
  return out;
}

/**
 * One complete signup: mailbox, page sign-in, validation. Used by both the
 * Reset button and the pool warmer, so there is a single code path.
 */
async function createClaudeAccount({ signal, emit = () => {}, provider = null } = {}) {
  const t0 = Date.now();

  // Two attempts at most: first the masked (WARP) route, then a direct one. A
  // Cloudflare egress is sometimes refused for signups, and a refusal must never
  // cost the user a reset.
  const attempts = cfg.useWarp ? [true, false] : [false];
  let box = null;
  let sessionKey = null;
  let lastErr = null;

  for (const warp of attempts) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "ECANCEL" });
    box = await createMailbox(signal, provider ? { force: provider } : {});
    log("[create] mailbox", {
      address: box.address,
      provider: box.provider,
      ms: Date.now() - t0,
      warp,
    });

    const adapter = adapterFor(box.provider);
    const mailPromise = waitForMail(adapter, box, signal);

    emit({ pct: 30, note: "signup" });
    try {
      sessionKey = await signInHeadless({ email: box.address, mailPromise, signal, emit, useWarp: warp });
      if (sessionKey) break;
      lastErr = new Error("sign-in produced no session");
    } catch (err) {
      lastErr = err;
      log("[create] signin failed", { warp, error: err?.message || String(err) });
      if (err?.code === "ECANCEL" || signal?.aborted) throw err;
    }
  }

  if (!sessionKey) throw lastErr || new Error("sign-in produced no session");
  log("[create] session", { via: "ok", ms: Date.now() - t0 });

  const info = await claudeAccountInfo(sessionKey);
  if (!info.ok) throw new Error(`new account is not usable (organizations ${info.status})`);
  const org = (info.orgs || [])[0] || {};

  const name = nextAccountName();
  const named = await setAccountName(sessionKey, name).catch(() => ({ ok: false }));
  log("[create] named", { name, applied: !!named?.ok });

  return {
    id: crypto.randomUUID(),
    email: box.address,
    name,
    named,
    password: "",
    provider: box.provider,
    sessionKey,
    createdAt: nowIso(),
    orgId: org.uuid || org.id || "",
    orgName: org.name || "",
    valid: true,
  };
}

/**
 * Diagnostic: opens the login page in a throwaway partition and dumps every
 * claude.ai API call it makes plus the body of each. Used to find out which
 * response carries the "new signups disabled" flag.
 */
async function probeLoginNetwork() {
  const host = hostWindow();
  if (!host) return { error: "no host window" };
  const part = session.fromPartition(`forma-probe-${crypto.randomUUID()}`, { cache: false });
  const view = new WebContentsView({
    webPreferences: { session: part, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const b = host.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  host.contentView.addChildView(view, 0);
  const wc = view.webContents;
  try {
    await withTimeout(wc.loadURL(`${CLAUDE_ORIGIN}/login`), 30_000, "load", null);
    await sleep(7000);
    const out = await withTimeout(
      wc.executeJavaScript(
        `(async () => {
          const all = performance.getEntriesByType("resource").map((e) => e.name);
          const api = [...new Set(all.filter((n) => n.includes("/api/") || n.includes("signup") || n.includes("auth")))];
          const bodies = {};
          for (const u of api.slice(0, 40)) {
            try {
              const r = await fetch(u, { headers: { accept: "application/json" }, credentials: "include" });
              const t = await r.text();
              bodies[u] = r.status + " " + t.replace(/\\s+/g, " ").slice(0, 700);
            } catch (e) {
              bodies[u] = "ERR " + e.message;
            }
          }
          return { api, bodies, page: (document.body.innerText || "").slice(0, 500) };
        })()`,
        true,
      ),
      60_000,
      "net-probe",
      null,
    );
    return out || { error: "probe returned nothing" };
  } finally {
    try {
      host.contentView.removeChildView(view);
    } catch {
      /* host gone */
    }
    try {
      if (!wc.isDestroyed()) wc.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Restore verification: proves, inside the running app, that an archived chat
 * is listed in the sidebar data and that opening it returns its messages.
 * Writes a screenshot plus a JSON report so the result can be checked without
 * driving the UI.
 */
async function probeRestore() {
  const deadline = Date.now() + 120_000;
  let wc = null;
  let ready = false;
  while (Date.now() < deadline) {
    wc = claudeWebContents();
    if (wc) {
      ready = await withTimeout(wc.executeJavaScript(JS_HAS_CHAT, true), 4_000, "restore-ready", false);
      if (ready) break;
    }
    await sleep(1000);
  }
  if (!wc) return { ok: false, error: "no claude view" };
  if (!ready) return { ok: false, error: "chat never became ready", href: wc.getURL() };

  await sleep(4000);

  let shot = null;
  try {
    const img = await withTimeout(wc.capturePage(), 20_000, "restore-shot", null);
    if (img && !img.isEmpty()) {
      shot = path.join(rootDir, "restore-view.png");
      fs.writeFileSync(shot, img.toPNG());
    }
  } catch (err) {
    shot = `failed: ${err?.message || err}`;
  }

  const index = await readJson(path.join(rootDir, "archive", "index.json"), { items: [] });
  const items = Array.isArray(index.items) ? index.items : [];
  const sorted = items
    .slice()
    .sort((a, b) => {
      const tb = Date.parse(String(b.updatedAt || b.capturedAt || "")) || 0;
      const ta = Date.parse(String(a.updatedAt || a.capturedAt || "")) || 0;
      return tb - ta;
    });
  const target = sorted.find((c) => Number(c.messageCount || 0) >= 2) || sorted[0];
  if (!target?.uuid) return { ok: false, error: "archive empty", shot };

  const script = `(async () => {
    const out = { href: location.href, org: null, v1: null, v2: null, detail: null, d1Check: null, sidebar: [], err: null };
    const uuid = ${JSON.stringify(String(target.uuid).toLowerCase())};
    try {
      const orgsRes = await fetch("/api/organizations", { credentials: "include" });
      const orgs = await orgsRes.json();
      const list = Array.isArray(orgs) ? orgs : [];
      const org = list.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || list[0];
      out.org = org ? org.uuid : null;
      const grab = async (url) => {
        const r = await fetch(url, { credentials: "include" });
        let j = null;
        try { j = await r.json(); } catch {}
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
        const ids = arr.map((c) => c && String(c.uuid).toLowerCase()).filter(Boolean);
        return {
          status: r.status,
          count: arr.length,
          uniqueCount: new Set(ids).size,
          hasTarget: ids.includes(uuid),
          names: arr.slice(0, 5).map((c) => c && c.name),
        };
      };
      if (out.org) {
        out.v1 = await grab("/api/organizations/" + out.org + "/chat_conversations?limit=200&offset=0");
        out.v2 = await grab("/api/organizations/" + out.org + "/chat_conversations_v2?limit=200&offset=0");
        const d = await fetch("/api/organizations/" + out.org + "/chat_conversations/" + uuid + "?tree=True&rendering_mode=messages&render_all_tools=true", { credentials: "include" });
        let dj = null;
        try { dj = await d.json(); } catch {}
        const msgs = dj && Array.isArray(dj.chat_messages) ? dj.chat_messages : [];
        out.detail = {
          status: d.status,
          uuid: dj && dj.uuid,
          name: dj && dj.name,
          read_only: dj ? Boolean(dj.read_only) : null,
          is_archived: dj ? Boolean(dj.is_archived) : null,
          disabled: dj ? Boolean(dj.disabled) : null,
          msgs: msgs.length,
          first: msgs[0] ? String(msgs[0].text || "").slice(0, 90) : "",
        };

        // D1 regression check: create a new live chat, verify it appears at top of hooked v2 list,
        // remains in liveUuids, stays openable after refetch, then clean up test chat.
        const markerUuid = crypto.randomUUID();
        const markerName = "forma-d1-probe-" + Date.now();
        let createdOk = false;
        let listedAfterCreate = false;
        let firstInList = false;
        let inLiveSet = false;
        let openAfterRefetch = false;
        let cleanedUp = false;
        const mkRes = await fetch("/api/organizations/" + out.org + "/chat_conversations", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uuid: markerUuid, name: markerName }),
        });
        createdOk = mkRes.ok;
        if (createdOk) {
          inLiveSet = !!(window.__formaLiveUuids && window.__formaLiveUuids.has(markerUuid.toLowerCase()));
          const listAfter = await fetch("/api/organizations/" + out.org + "/chat_conversations_v2?limit=200&offset=0", { credentials: "include" });
          const listAfterJson = await listAfter.json().catch(() => null);
          const arrAfter = Array.isArray(listAfterJson) ? listAfterJson : (listAfterJson && Array.isArray(listAfterJson.data) ? listAfterJson.data : []);
          const idx = arrAfter.findIndex((c) => c && String(c.uuid).toLowerCase() === markerUuid.toLowerCase());
          listedAfterCreate = idx >= 0;
          firstInList = idx === 0;
          const openRes = await fetch("/api/organizations/" + out.org + "/chat_conversations/" + markerUuid + "?tree=True&rendering_mode=messages&render_all_tools=true", { credentials: "include" });
          const openJson = await openRes.json().catch(() => null);
          openAfterRefetch = !!(openRes.ok && openJson && String(openJson.uuid).toLowerCase() === markerUuid.toLowerCase());
        }

        // Context proof: send one real turn through the hooked fetch and read
        // the stored user message back. This is the only honest way to show
        // that [FORMA_CONTEXT] reaches the model and stays in the transcript.
        let ctxSent = false;
        let ctxStored = false;
        let ctxTools = null;
        let ctxFirst = "";
        if (createdOk) {
          try {
            const comp = await fetch("/api/organizations/" + out.org + "/chat_conversations/" + markerUuid + "/completion", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                prompt: "yo",
                parent_message_uuid: "00000000-0000-4000-8000-000000000000",
                timezone: "Europe/Berlin",
                attachments: [],
                files: [],
              }),
            });
            ctxSent = comp.ok;
            try { if (comp.body && comp.body.cancel) comp.body.cancel().catch(() => {}); } catch {}
            await new Promise((r) => setTimeout(r, 5000));
            const det = await fetch("/api/organizations/" + out.org + "/chat_conversations/" + markerUuid + "?tree=True&rendering_mode=messages&render_all_tools=true", { credentials: "include" });
            const dj2 = await det.json().catch(() => null);
            const msgs2 = dj2 && Array.isArray(dj2.chat_messages) ? dj2.chat_messages : [];
            const textOf = (m) => {
              if (!m) return "";
              if (typeof m.text === "string" && m.text) return m.text;
              if (Array.isArray(m.content)) {
                return m.content.map((b) => (b && (b.text || b.thinking)) || "").filter(Boolean).join("\\n");
              }
              return "";
            };
            const human = msgs2.find((m) => m && (m.sender === "human" || m.role === "user"));
            ctxFirst = textOf(human).slice(0, 300);
            ctxStored = /\\[FORMA_CONTEXT\\]/.test(ctxFirst);
            const m2 = ctxFirst.match(/AVAILABLE TOOLS \\((\\d+)\\)/);
            ctxTools = m2 ? Number(m2[1]) : null;
          } catch (e) {
            ctxFirst = "ERR " + String((e && e.message) || e);
          }
        }
        out.ctxCheck = { ctxSent, ctxStored, ctxTools, first: ctxFirst };
        if (createdOk) {
          const delRes = await fetch("/api/organizations/" + out.org + "/chat_conversations/" + markerUuid, {
            method: "DELETE",
            credentials: "include",
          }).catch(() => null);
          cleanedUp = !!(delRes && (delRes.ok || delRes.status === 204 || delRes.status === 404));
        }
        out.d1Check = {
          markerUuid,
          createdOk,
          inLiveSet,
          listedAfterCreate,
          firstInList,
          openAfterRefetch,
          cleanedUp,
          ok: createdOk && inLiveSet && listedAfterCreate && openAfterRefetch,
        };
      }
      const nodes = Array.from(document.querySelectorAll("a[href*='/chat/'], nav button, aside button"));
      out.sidebar = nodes
        .map((el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim())
        .filter((t) => t && t.length < 60)
        .slice(0, 40);
    } catch (e) {
      out.err = String((e && e.message) || e);
    }
    return out;
  })()`;

  const page = await withTimeout(wc.executeJavaScript(script, true), 60_000, "restore-js", null);

  const key = await currentSessionKey();
  let direct = null;
  if (key) {
    const orgs = await claudeApiGet("/api/organizations", key).catch(() => null);
    const list = Array.isArray(orgs?.json) ? orgs.json : [];
    const org = list.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || list[0];
    if (org) {
      const live = await claudeApiGet(
        `/api/organizations/${org.uuid}/chat_conversations_v2?limit=200&offset=0`,
        key,
      ).catch(() => null);
      const arr = Array.isArray(live?.json) ? live.json : live?.json?.data || [];
      direct = { org: org.uuid, status: live?.status ?? null, live: arr.length };
    }
  }

  const indexCount = items.length;
  const reconciled = !!(
    page &&
    page.v2 &&
    page.v2.count === page.v2.uniqueCount &&
    page.v2.count >= indexCount
  );
  const editable = !!(
    page &&
    page.detail &&
    page.detail.read_only === false &&
    page.detail.is_archived === false &&
    page.detail.disabled === false
  );
  const ctxOk = !!(page && page.ctxCheck && page.ctxCheck.ctxSent && page.ctxCheck.ctxStored);
  const ok = !!(
    page &&
    page.v2 &&
    page.v2.hasTarget &&
    page.detail &&
    page.detail.msgs >= 2 &&
    editable &&
    reconciled &&
    page.d1Check &&
    page.d1Check.ok &&
    ctxOk
  );
  return {
    ok,
    shot,
    indexCount,
    reconciled,
    editable,
    ctx: page ? page.ctxCheck || null : null,
    target: { uuid: target.uuid, name: target.name, messages: target.messageCount },
    direct,
    page,
  };
}

let selfTestStarted = false;

async function runSelfTest() {
  if (selfTestStarted) return;
  selfTestStarted = true;
  const flag = path.join(rootDir, "selftest.flag");
  if (!fs.existsSync(flag)) return;

  let wanted = "";
  try {
    wanted = fs.readFileSync(flag, "utf8").trim();
  } catch {
    wanted = "";
  }
  try {
    fs.unlinkSync(flag);
  } catch {
    /* ignore */
  }

  const report = { startedAt: nowIso(), steps: [] };
  const push = (name, data) => {
    report.steps.push({ name, at: nowIso(), ...(data || {}) });
    log("[selftest]", name, data || "");
  };

  const previous = await currentSessionKey();
  const timings = {};

  try {
    if (wanted === "reset") {
      // Drives the real button path (archive, signup, switch) with no UI input.
      await sleep(7000, null).catch(() => {});
      const t0 = Date.now();
      const out = await runReset().catch((e) => ({ ok: false, error: e?.message || String(e) }));
      report.ok = !!(out && out.ok);
      report.result = out || null;
      report.timings = { totalMs: Date.now() - t0 };
      return;
    }

    if (!wanted) push("provider-bench", await benchProviders());
    if (wanted) cfg.provider = wanted;

    if (wanted === "probe") {
      push("window-survival", await probeWindowSurvival());
      report.ok = true;
      return;
    }

    if (wanted === "restore") {
      const result = await probeRestore();
      push("restore", result);

      // Prove the local tool bridge really executes on this PC, not just that
      // the header advertises tools.
      let toolsOk = false;
      let toolsCount = 0;
      try {
        const a = getAgent();
        if (!a) throw new Error("agent unavailable: " + (formaAgentError || "no controller"));
        const hdr = await a.buildPromptHeader();
        const m = hdr.match(/AVAILABLE TOOLS \((\d+)\)/);
        toolsCount = m ? Number(m[1]) : 0;
        const wc = webContents
          .getAllWebContents()
          .find((w) => !w.isDestroyed() && /claude\.ai/.test(w.getURL() || ""));
        const res = await a.executeToolBatch(wc || null, {
          chatId: "selftest-tools",
          tools: [
            {
              id: "t1",
              name: "run_command",
              arguments: { command: "echo forma-tool-ok", purpose: "verify tool bridge" },
            },
          ],
        });
        const blob = JSON.stringify(res);
        toolsOk = blob.includes("forma-tool-ok");
        push("tools", { ok: toolsOk, tools: toolsCount, headerLen: hdr.length, sample: blob.slice(0, 400) });
      } catch (e) {
        push("tools", { ok: false, tools: toolsCount, error: String(e?.message || e) });
      }

      report.ok = !!result.ok && toolsOk;
      return;
    }

    if (wanted === "chat") {
      // Full path through the patched renderer: real chat, real completion,
      // real tool execution. Proves the bridge works without UI clicking.
      const wc = claudeWebContents();
      if (!wc) {
        push("chat", { ok: false, error: "no claude view" });
        report.ok = false;
        return;
      }
      const script = `(async () => {
        const out = { ok: false };
        const textOf = (m) => {
          if (!m) return "";
          if (typeof m.text === "string" && m.text) return m.text;
          if (Array.isArray(m.content)) return m.content.map((b) => (b && (b.text || "")) || "").filter(Boolean).join("\\n");
          return "";
        };
        try {
          const orgs = await (await fetch("/api/organizations", { credentials: "include" })).json();
          const list = Array.isArray(orgs) ? orgs : [];
          const org = list.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || list[0];
          if (!org) throw new Error("no org");
          out.org = org.uuid;
          const cr = await fetch("/api/organizations/" + org.uuid + "/chat_conversations", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "forma selftest chat" }),
          });
          const created = await cr.json().catch(() => null);
          const uuid = created && created.uuid;
          if (!uuid) throw new Error("create failed HTTP " + cr.status);
          out.uuid = uuid;
          const comp = await fetch("/api/organizations/" + org.uuid + "/chat_conversations/" + uuid + "/completion", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prompt: "Nenne die 3 groessten Dateien in C:/Users/furaa/Downloads mit ihrer Groesse. Nutze deine Tools, nicht dein Wissen.",
              parent_message_uuid: "00000000-0000-4000-8000-000000000000",
              timezone: "Europe/Berlin",
              attachments: [],
              files: [],
            }),
          });
          out.status = comp.status;
          const body = await comp.text();
          out.streamLen = body.length;
          await new Promise((r) => setTimeout(r, 12000));
          const det = await (await fetch("/api/organizations/" + org.uuid + "/chat_conversations/" + uuid + "?tree=True&rendering_mode=messages&render_all_tools=true", { credentials: "include" })).json();
          const msgs = det && Array.isArray(det.chat_messages) ? det.chat_messages : [];
          out.msgCount = msgs.length;
          out.toolRounds = msgs.filter((m) => m.sender === "human" && textOf(m).startsWith("FORMA_TOOL_RESULT ")).length;
          out.hasCtx = msgs.some((m) => m.sender === "human" && textOf(m).includes("[FORMA_CONTEXT]"));
          out.toolSample = msgs
            .filter((m) => m.sender === "human" && textOf(m).startsWith("FORMA_TOOL_RESULT "))
            .map((m) => textOf(m).slice(0, 260));
          const lastAssistant = [...msgs].reverse().find((m) => m.sender !== "human");
          out.last = lastAssistant ? textOf(lastAssistant).slice(0, 500) : "";
          out.refused = /(?:keinen|no) zugriff|no access to your|nicht auf ihren pc/i.test(out.last);
          out.ok = !!(out.hasCtx && out.toolRounds >= 1 && !out.refused);
          await fetch("/api/organizations/" + org.uuid + "/chat_conversations/" + uuid, {
            method: "DELETE",
            credentials: "include",
          }).catch(() => {});
        } catch (e) {
          out.err = String((e && e.message) || e);
        }
        return out;
      })()`;
      const res = await withTimeout(wc.executeJavaScript(script, true), 180_000, "chat-test", null).catch((e) => ({
        ok: false,
        error: String(e?.message || e),
      }));
      push("chat", res || { ok: false });
      report.ok = !!(res && res.ok);
      return;
    }

    if (wanted === "visible") {
      // Non-destructive visibility proof: find a live chat whose stored human
      // message still contains [FORMA_CONTEXT], open it in the real renderer,
      // then assert the notice is actually painted (not display:none).
      const out = { ok: false };
      try {
        const key = await currentSessionKey();
        if (!key) throw new Error("no live session cookie");
        const orgs = await claudeApiGet("/api/organizations", key);
        const list = Array.isArray(orgs?.json) ? orgs.json : [];
        const org = list.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || list[0];
        if (!org) throw new Error("no org");
        const live = await claudeApiGet(
          `/api/organizations/${org.uuid}/chat_conversations_v2?limit=80&offset=0`,
          key,
        );
        const arr = Array.isArray(live?.json) ? live.json : live?.json?.data || [];
        out.scanned = arr.length;
        let found = null;
        for (const c of arr) {
          if (!c?.uuid) continue;
          const d = await claudeApiGet(
            `/api/organizations/${org.uuid}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
            key,
          ).catch(() => null);
          const msgs = Array.isArray(d?.json?.chat_messages) ? d.json.chat_messages : [];
          const human = msgs.find(
            (m) => m && m.sender === "human" && messageText(m).includes("[FORMA_CONTEXT]"),
          );
          if (human) {
            found = { uuid: c.uuid, name: c.name, msgs: msgs.length, len: messageText(human).length };
            break;
          }
        }
        out.found = found;
        if (!found) throw new Error("no stored conversation contains [FORMA_CONTEXT]");

        const wc = claudeWebContents();
        if (!wc) throw new Error("no claude view");
        await wc.loadURL(`https://claude.ai/chat/${found.uuid}`).catch(() => {});
        await sleep(9000);

        const dom = await withTimeout(
          wc.executeJavaScript(
            `(() => {
               const t = document.body ? document.body.innerText || "" : "";
               const has = t.includes("[FORMA_CONTEXT]");
               let visible = false;
               let sample = "";
               const all = document.querySelectorAll("*");
               for (const n of all) {
                 if (n.children && n.children.length) continue;
                 const s = n.textContent || "";
                 if (!s.includes("[FORMA_CONTEXT]")) continue;
                 const r = n.getBoundingClientRect();
                 const cs = getComputedStyle(n);
                 if (r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05) {
                   visible = true;
                   sample = s.slice(0, 120);
                   break;
                 }
               }
               return { has, visible, sample, bodyLen: t.length, href: location.href };
             })()`,
            true,
          ),
          20_000,
          "visible-dom",
          null,
        );
        out.dom = dom;

        try {
          const img = await withTimeout(wc.capturePage(), 20_000, "visible-shot", null);
          if (img && !img.isEmpty()) {
            out.shot = path.join(rootDir, "ctx-visible.png");
            fs.writeFileSync(out.shot, img.toPNG());
          }
        } catch (e) {
          out.shotError = String(e?.message || e);
        }

        out.ok = !!(dom && dom.has && dom.visible);
        await wc.loadURL("https://claude.ai/new").catch(() => {});
      } catch (e) {
        out.error = String(e?.message || e);
      }
      push("visible", out);
      report.ok = !!out.ok;
      return;
    }

    if (wanted === "barrier") {
      // Non-destructive: runs the same capture barrier the Reset button uses
      // and reports whether it would block. Proves the fix without switching
      // accounts or touching the live session.
      const store = getStore();
      if (!store || typeof store.captureBarrier !== "function") {
        push("barrier", { ok: false, error: "chat store unavailable" });
        report.ok = false;
        return;
      }
      const t0 = Date.now();
      const b = await store.captureBarrier({
        email: cfg.currentEmail,
        timeoutMs: 90_000,
        emit: () => {},
      }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      push("barrier", {
        ok: !!b?.ok,
        complete: !!b?.complete,
        captured: b?.captured ?? null,
        expected: b?.expected ?? null,
        emptyCount: b?.emptyCount ?? null,
        lossyCount: b?.lossyCount ?? null,
        conversations: b?.conversations ?? null,
        messages: b?.messages ?? null,
        reason: b?.reason || b?.error || null,
        ms: Date.now() - t0,
      });
      report.ok = !!b?.ok;
      return;
    }

    if (wanted === "persist") {
      const key = await currentSessionKey();
      const orgs = await claudeApiGet("/api/organizations", key);
      const org = Array.isArray(orgs.json) ? orgs.json[0] : null;
      if (!org) {
        push("persist", { ok: false, error: "no org" });
        report.ok = false;
        return;
      }
      const marker = `forma persist ${Date.now()}`;
      const made = await httpJson(`${CLAUDE_ORIGIN}/api/organizations/${org.uuid}/chat_conversations`, {
        method: "POST",
        headers: {
          ...CLAUDE_HEADERS,
          cookie: `sessionKey=${key}`,
          accept: "application/json",
        },
        body: { name: marker },
        timeoutMs: 20_000,
      }).catch(() => null);
      push("persist-create", {
        status: made ? made.status : "network",
        uuid: made?.json?.uuid || null,
        text: made && !made.ok ? String(made.text || "").slice(0, 200) : "",
      });
      const archive = await archiveAccount({ sessionKey: key, email: cfg.currentEmail, emit: () => {} });
      const found = archive.conversations.find((c) => c.name === marker);
      push("persist-archive", {
        marker,
        count: archive.count,
        found: !!found,
        messages: found ? found.messages.length : 0,
        file: archive.id,
      });
      report.ok = !!found;
      return;
    }

    if (wanted === "settings") {
      const key = await currentSessionKey();
      const hdr = { ...CLAUDE_HEADERS, cookie: `sessionKey=${key}`, accept: "application/json" };
      for (const method of ["GET", "POST", "PUT", "PATCH"]) {
        const res = await httpJson(`${CLAUDE_ORIGIN}/api/account/settings`, {
          method,
          headers: hdr,
          body: method === "GET" ? undefined : {},
          timeoutMs: 15_000,
        }).catch(() => null);
        const json = res?.json || {};
        const onb = {};
        for (const k of Object.keys(json)) {
          if (/onboard|starter|mm_examples|tour/i.test(k)) onb[k] = json[k];
        }
        push(`settings-${method}`, {
          status: res ? res.status : "network",
          onboarding: onb,
          keys: Object.keys(json).length,
          text: res && !res.ok ? String(res.text || "").slice(0, 120) : "",
        });
      }
      report.ok = true;
      return;
    }

    if (wanted === "net") {
      push("login-network", await probeLoginNetwork());
      report.ok = true;
      return;
    }

    if (wanted === "name") {
      const key = await currentSessionKey();
      const hdr = { ...CLAUDE_HEADERS, cookie: `sessionKey=${key}`, accept: "application/json" };
      const before = await httpJson(`${CLAUDE_ORIGIN}/api/account`, { headers: hdr, timeoutMs: 15_000 });
      push("account-before", { status: before.status, body: String(before.text || "").slice(0, 700) });
      const applied = await setAccountName(key, "forma acc 99");
      const after = await httpJson(`${CLAUDE_ORIGIN}/api/account`, { headers: hdr, timeoutMs: 15_000 });
      push("account-after", { applied, status: after.status, body: String(after.text || "").slice(0, 700) });
      report.ok = true;
      return;
    }

    // No cookie clearing: the signup runs in its own throwaway partition, so
    // the user's session survives a failed attempt untouched.
    const t0 = Date.now();
    const account = await createClaudeAccount({ emit: () => {}, provider: wanted || null });
    timings.totalMs = Date.now() - t0;
    push("created", {
      ok: !!account.sessionKey,
      email: account.email,
      provider: account.provider,
      org: account.orgName,
      ms: timings.totalMs,
    });
    if (account.sessionKey) {
      await clearClaudeCookies().catch(() => {});
      await injectSession(account.sessionKey);
      cfg.currentEmail = account.email;
      writeJson(configPath(), cfg).catch(() => {});
    }
    report.ok = !!account.sessionKey;
    report.timings = timings;
    report.provider = account.provider;
    report.email = account.email;
    report.name = account.name;
  } catch (err) {
    report.ok = false;
    report.error = err?.message || String(err);
    report.timings = timings;
    push("error", { message: report.error });
  } finally {
    if (!report.ok && previous) await injectSession(previous).catch(() => {});
    report.finishedAt = nowIso();
    try {
      fs.writeFileSync(path.join(rootDir, "selftest-report.json"), JSON.stringify(report, null, 2));
    } catch {
      /* ignore */
    }
    log("[selftest] done", { ok: report.ok, error: report.error, timings });
    setTimeout(() => {
      try {
        reloadClaudeViews();
      } catch {
        /* ignore */
      }
    }, 800);
  }
}

// ---------------------------------------------------------------------------
// session control
// ---------------------------------------------------------------------------

function claudeSession() {
  return session.defaultSession;
}

async function injectSession(sessionKey) {
  const ses = claudeSession();
  await ses.cookies.set({
    url: CLAUDE_ORIGIN,
    name: "sessionKey",
    value: sessionKey,
    domain: ".claude.ai",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
  });
  return true;
}

async function currentSessionKey() {
  const ses = claudeSession();
  const list = await ses.cookies.get({ url: CLAUDE_ORIGIN, name: "sessionKey" });
  return list?.[0]?.value || null;
}

async function clearClaudeStorage() {
  const ses = claudeSession();
  await ses.clearStorageData({
    origin: CLAUDE_ORIGIN,
    storages: ["cookies", "localstorage", "indexeddb", "cachestorage", "serviceworkers", "websql"],
  });
}

/**
 * Removes every claude.ai cookie. Needed before a headless sign-in, otherwise
 * /login bounces straight to /new because a session is still present.
 */
async function clearClaudeCookies() {
  const ses = claudeSession();
  const jars = await Promise.all([
    ses.cookies.get({ domain: "claude.ai" }).catch(() => []),
    ses.cookies.get({ url: CLAUDE_ORIGIN }).catch(() => []),
  ]);
  const seen = new Set();
  for (const c of jars.flat()) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    await ses.cookies.remove(CLAUDE_ORIGIN, c.name).catch(() => {});
  }
  await ses
    .clearStorageData({ origin: CLAUDE_ORIGIN, storages: ["localstorage", "indexeddb", "cachestorage", "serviceworkers"] })
    .catch(() => {});
}

function reloadClaudeViews() {
  for (const wc of webContents.getAllWebContents()) {
    try {
      const url = wc.getURL();
      if (url.startsWith(CLAUDE_ORIGIN) || url.startsWith("https://claude.com")) {
        wc.loadURL(CLAUDE_ORIGIN);
      }
    } catch {
      /* destroyed between iteration and call */
    }
  }
}

/** The app's visible claude.ai view (the one the user looks at). */
function claudeWebContents() {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed()) continue;
      const url = wc.getURL();
      if (/^https:\/\/claude\.(ai|com)\//.test(url)) return wc;
    } catch {
      /* destroyed */
    }
  }
  return null;
}

/**
 * After a session swap the visible window can still sit on the tutorial. This
 * finishes it in place, so the reset ends on a usable chat and the user never
 * has to click anything.
 */
async function ensureChatReady(emit, signal) {
  const deadline = Date.now() + 60_000;
  let nudged = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const wc = claudeWebContents();
    if (!wc) {
      await sleep(500, signal);
      continue;
    }
    const hasChat = await withTimeout(wc.executeJavaScript(JS_HAS_CHAT, true), 4_000, "chat-check", false);
    if (hasChat) return true;
    const url = wc.getURL();
    if (/onboarding|welcome|setup|login/i.test(url)) {
      const done = await withTimeout(completeOnboarding(wc, signal, emit), 70_000, "visible-onboarding", false);
      if (done) return true;
    } else if (nudged < 2) {
      nudged += 1;
      await withTimeout(wc.loadURL(`${CLAUDE_ORIGIN}/new`), 20_000, "to-new", null);
    }
    await sleep(600, signal);
  }
  return false;
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

async function claudeApiGet(pathname, sessionKey, timeoutMs = 25_000) {
  return httpJson(`${CLAUDE_ORIGIN}${pathname}`, {
    headers: {
      accept: "application/json",
      "user-agent": CLAUDE_UA,
      "anthropic-client-platform": "web_claude_ai",
      cookie: `sessionKey=${sessionKey}`,
    },
    timeoutMs,
  });
}

function messageText(m) {
  if (typeof m?.text === "string" && m.text.trim()) return m.text;
  if (Array.isArray(m?.content)) {
    const parts = m.content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : ""))
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  if (typeof m?.content === "string") return m.content;
  return "";
}

async function archiveAccount({ sessionKey, email, orgId, emit, signal }) {
  const orgsRes = await claudeApiGet("/api/organizations", sessionKey);
  const orgs = Array.isArray(orgsRes.json) ? orgsRes.json : [];
  const org = orgId ? orgs.find((o) => o.uuid === orgId) : orgs[0];
  if (!org) throw new Error("no organization on this account");
  const listRes = await claudeApiGet(
    `/api/organizations/${org.uuid}/chat_conversations?limit=${LIMITS.archiveMaxConversations}&offset=0`,
    sessionKey,
  );
  const list = Array.isArray(listRes.json) ? listRes.json : [];
  emit({ step: "archive", state: "list", total: list.length });

  const conversations = [];
  let bytes = 0;
  let index = 0;

  const workers = Array.from({ length: LIMITS.archiveConcurrency }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = index;
      index += 1;
      if (i >= list.length) return;
      const item = list[i];
      try {
        const detail = await claudeApiGet(
          `/api/organizations/${org.uuid}/chat_conversations/${item.uuid}`,
          sessionKey,
        );
        const d = detail.json || {};
        const messages = (d.chat_messages || []).map((m) => ({
          role: m.sender === "human" ? "user" : "assistant",
          text: messageText(m),
          at: m.created_at || null,
        }));
        const conv = {
          uuid: item.uuid,
          name: d.name || item.name || "Untitled",
          createdAt: d.created_at || item.created_at || null,
          updatedAt: d.updated_at || item.updated_at || null,
          messages,
        };
        bytes += Buffer.byteLength(JSON.stringify(conv));
        conversations.push(conv);
      } catch {
        /* one bad conversation does not fail the archive */
      }
      if (bytes > LIMITS.archiveMaxBytes) {
        index = list.length;
        return;
      }
      emit({
        step: "archive",
        state: "progress",
        done: conversations.length,
        total: list.length,
      });
    }
  });

  await Promise.all(workers);

  conversations.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const archive = {
    id: crypto.randomUUID(),
    email: email || "unknown",
    orgId: org.uuid,
    orgName: org.name || null,
    capturedAt: nowIso(),
    count: conversations.length,
    conversations,
  };

  // One snapshot per account, always current: merging by conversation uuid means
  // a chat that disappears server-side (account switch, deletion) is still kept.
  const slug = String(email || org.uuid)
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "_")
    .slice(0, 80);
  const file = path.join(rootDir, "archive", `${slug || archive.id}.json`);
  const previous = await readJson(file, null);
  if (previous && Array.isArray(previous.conversations)) {
    const byId = new Map();
    for (const c of previous.conversations) byId.set(c.uuid, c);
    for (const c of conversations) {
      const old = byId.get(c.uuid);
      const newer =
        !old ||
        String(c.updatedAt || "").localeCompare(String(old.updatedAt || "")) >= 0 ||
        (c.messages || []).length >= (old.messages || []).length;
      byId.set(c.uuid, newer ? c : old);
    }
    archive.conversations = Array.from(byId.values()).sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    );
    archive.count = archive.conversations.length;
  }
  archive.id = slug || archive.id;
  archive.savedAt = nowIso();

  await writeJson(file, archive);
  await pruneArchives();
  return archive;
}

async function pruneArchives() {
  const dir = path.join(rootDir, "archive");
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
  // 0 means unlimited: the user asked for no cap on saved history.
  const keep = Number(cfg.keepHistory || 0);
  if (!keep || files.length <= keep) return;
  const stats = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (st) stats.push({ f, t: st.mtimeMs });
  }
  stats.sort((a, b) => a.t - b.t);
  for (const { f } of stats.slice(0, Math.max(0, stats.length - keep))) {
    await fsp.unlink(path.join(dir, f)).catch(() => {});
  }
}

async function listArchives() {
  const dir = path.join(rootDir, "archive");
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const raw = await readJson(path.join(dir, f), null);
    if (!raw) continue;
    out.push({
      id: raw.id,
      email: raw.email,
      orgName: raw.orgName,
      capturedAt: raw.capturedAt,
      count: raw.count,
    });
  }
  out.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
  return out;
}

// ---------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------

async function readPool() {
  return readJson(poolPath(), []);
}

async function writePool(list) {
  await writeJson(poolPath(), list);
}

async function readAccounts() {
  return readJson(accountsPath(), []);
}

async function appendAccount(account) {
  const list = await readAccounts();
  list.unshift(account);
  await writeJson(accountsPath(), list.slice(0, 200));
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function emit(event) {
  const payload = { ...event, at: nowIso() };
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (!wc.isDestroyed()) wc.send(CH.event, payload);
    } catch {
      /* window closed mid-send */
    }
  }
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * Background snapshots: while the app is open the current account is archived
 * whenever its conversation list changes, so chats survive a crash, a manual
 * account switch or a reset that never finished. One extra request per tick.
 */
const autoSig = new Map();
let autoTimer = null;
let lastAutoKey = null;

async function autoCaptureTick() {
  if (running || !cfg.autoCapture) return;
  try {
    // A switch can happen outside the reset flow (another window, a restored
    // session). Capture the previous session the moment its key changes, or
    // those chats become unreachable.
    const liveKey = await currentSessionKey().catch(() => null);
    if (liveKey && lastAutoKey && liveKey !== lastAutoKey) {
      try {
        const prevEmail = (await accountEmail(lastAutoKey)) || cfg.currentEmail;
        const prev = await archiveAccount({ sessionKey: lastAutoKey, email: prevEmail, emit: () => {} });
        log("[auto] archived previous account after switch", { email: prevEmail, count: prev.count });
      } catch (err) {
        log("[auto] previous-account capture skipped", { error: err?.message || String(err) });
      }
    }
    if (liveKey) lastAutoKey = liveKey;
    // The store is idempotent and merges by message hash, so the old
    // "list signature" shortcut is unnecessary — and it was a source of missed
    // captures when updated_at granularity collided.
    const store = getStore();
    if (store) {
      const result = await store.captureQuiet({ email: cfg.currentEmail, allAccounts: true });
      if (result?.ok) log("[auto] archived", { conversations: result.conversations, messages: result.messages });
      else log("[auto] skipped", { reason: result?.reason || "unknown" });
      return;
    }
    const key = await currentSessionKey();
    if (!key) return;
    const orgsRes = await claudeApiGet("/api/organizations", key);
    const org = Array.isArray(orgsRes.json) ? orgsRes.json[0] : null;
    if (!org) return;
    const listRes = await claudeApiGet(
      `/api/organizations/${org.uuid}/chat_conversations?limit=100&offset=0`,
      key,
    );
    const arr = Array.isArray(listRes.json) ? listRes.json : [];
    const stamps = arr.map((c) => String(c.updated_at || c.created_at || "")).sort();
    const sig = arr.length + "|" + (stamps[stamps.length - 1] || "");
    if (autoSig.get(org.uuid) === sig) return;
    autoSig.set(org.uuid, sig);
    const accounts = await readAccounts();
    const email = (await accountEmail(key)) || cfg.currentEmail || accounts[0]?.email || org.uuid;
    const archive = await archiveAccount({ sessionKey: key, email, orgId: org.uuid, emit: () => {} });
    log("[auto] archived", { email, count: archive.count });
  } catch (err) {
    log("[auto] skipped", { error: err?.message || String(err) });
  }
}

function startAutoCapture() {
  if (autoTimer) return;
  autoTimer = setInterval(() => {
    autoCaptureTick();
  }, 2 * 60_000);
  setTimeout(() => {
    autoCaptureTick();
  }, 8_000);
}


async function runReset(opts = {}) {
  if (running) throw new Error("a reset is already running");
  if (forma && !forma.features().includes("reset")) {
    throw new Error("Forma Claude access is not active");
  }
  const forceIncomplete = Boolean(opts && opts.forceIncomplete);
  const controller = new AbortController();
  const id = crypto.randomUUID();
  running = { id, controller };
  const signal = controller.signal;
  const pct = (p, phase, message) => emit({ runId: id, pct: p, phase, ...(message ? { message } : {}) });

  try {
    pct(3, "archive", "Archiving conversations…");
    let archived = 0;
    if (cfg.autoCapture) {
      const store = getStore();
      if (store && typeof store.captureBarrier === "function") {
        const barrier = await store.captureBarrier({
          email: cfg.currentEmail,
          signal,
          timeoutMs: 60_000,
          emit: (e) => emit({ runId: id, ...e }),
        });
        archived = barrier?.conversations || 0;
        if (!barrier?.ok && !forceIncomplete) {
          const reason = barrier?.reason || "capture incomplete; nothing was reset";
          emit({ runId: id, pct: 0, phase: "aborted", message: reason, incomplete: true });
          return {
            ok: false,
            aborted: true,
            incomplete: true,
            timedOut: Boolean(barrier?.timedOut),
            captured: barrier?.captured || 0,
            expected: barrier?.expected || 0,
            reason,
          };
        }
        if (barrier?.ok) {
          pct(10, "archive", `Archived ${archived} conversations.`);
        }
      } else {
        const key = await currentSessionKey();
        if (key) {
          const info = await claudeAccountInfo(key);
          if (info.ok) {
            const archive = await archiveAccount({
              sessionKey: key,
              email: (await accountEmail(key)) || cfg.currentEmail || (await readAccounts())[0]?.email,
              emit: (e) => emit({ runId: id, ...e }),
              signal,
            });
            archived = archive.count;
          }
        }
      }
    }
    pct(12, "signup", `Archived ${archived} conversations. Creating fresh account…`);

    let account = null;
    const pool = await readPool();
    if (pool.length) {
      account = pool.shift();
      await writePool(pool);
      pct(30, "pool-hit", "Using pre-warmed account…");
    } else {
      // The signup runs in its own throwaway session, so the current login is
      // never touched until a new account is ready to take over.
      try {
        account = await createClaudeAccount({ signal, emit: (e) => emit({ runId: id, ...e }) });
      } catch (err) {
        // A provider-side signup gate is not a failure of this machine. Stop
        // cleanly: the archive above is complete, the current session is
        // untouched, and the user is told exactly what happened.
        if (err && err.code === "EGATE") {
          log("[reset] signup gated", { captured: archived });
          emit({
            runId: id,
            pct: 0,
            phase: "gated",
            message:
              "Claude is not accepting new signups right now. Your current account stays signed in and every chat is already archived. Try again later.",
            gated: true,
          });
          return {
            ok: false,
            gated: true,
            keptSession: true,
            archived,
            reason: "signup gate active",
          };
        }
        throw err;
      }
      await appendAccount(account);
    }

    pct(97, "switch", "Switching session…");
    // A clean jar guarantees the app cannot keep the previous account's cached
    // identity in localStorage while showing the new session.
    await clearClaudeCookies().catch(() => {});
    await injectSession(account.sessionKey);
    cfg.currentEmail = account.email;
    writeJson(configPath(), cfg).catch(() => {});
    if (cfg.autoSwitch) {
      reloadClaudeViews();
      await sleep(1200, signal);
      pct(99, "ready", "Loading workspace…");
      const ready = await ensureChatReady((e) => emit({ runId: id, ...e }), signal);
      log("[reset] chat ready", { ready, name: account.name });
    }
    pct(100, "done", `Ready. ${archived} conversations in sidebar.`);
    return { ok: true, email: account.email, name: account.name, archived };
  } catch (err) {
    if (err?.code === "ECANCEL") {
      emit({ runId: id, pct: 0, phase: "cancelled", message: "Reset cancelled." });
      return { ok: false, cancelled: true };
    }
    emit({ runId: id, pct: 0, phase: "error", message: err?.message || String(err) });
    throw err;
  } finally {
    running = null;
  }
}

async function createPoolEntry() {
  const account = await createClaudeAccount({ signal: undefined, emit: () => {} });
  const pool = await readPool();
  pool.push(account);
  await writePool(pool.slice(0, LIMITS.poolMax));
  await appendAccount(account);
  return account;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle(CH.getConfig, async () => ({
    config: cfg,
    providers: Object.keys(PROVIDERS).map((name) => ({
      name,
      needsKey: PROVIDERS[name].needsKey,
      needsBaseUrl: PROVIDERS[name].kind === "custom",
    })),
  }));

  ipcMain.handle(CH.setConfig, async (_e, patch) => {
    cfg = { ...cfg, ...(patch || {}) };
    await writeJson(configPath(), cfg);
    return cfg;
  });

  ipcMain.handle(CH.run, async (_e, opts) => runReset(opts || {}));

  ipcMain.handle(CH.cancel, async () => {
    if (!running) return { ok: false };
    running.controller.abort();
    return { ok: true };
  });

  ipcMain.handle(CH.status, async () => {
    const key = await currentSessionKey();
    const accounts = await readAccounts();
    const pool = await readPool();
    let live = null;
    if (key) {
      const info = await claudeAccountInfo(key);
      live = { signedIn: info.ok, orgs: info.orgs?.map((o) => ({ uuid: o.uuid, name: o.name })) || [] };
    }
    return {
      running: !!running,
      signedIn: !!live?.signedIn,
      orgs: live?.orgs || [],
      pool: pool.length,
      accounts: accounts.slice(0, 20).map((a) => ({
        email: a.email,
        createdAt: a.createdAt,
        orgName: a.orgName,
      })),
      archiveCount: (await listArchives()).length,
    };
  });

  ipcMain.handle(CH.pool, async () => readPool());

  ipcMain.handle(CH.poolCreate, async (_e, count) => {
    const want = Math.min(LIMITS.poolMax, Math.max(1, Number(count) || 1));
    const created = [];
    for (let i = 0; i < want; i += 1) {
      const account = await createPoolEntry();
      created.push(account.email);
      emit({ step: "pool", state: "created", address: account.email, remaining: i + 1 });
    }
    return { created, total: (await readPool()).length };
  });

  ipcMain.handle(CH.poolDrop, async (_e, email) => {
    const pool = await readPool();
    const next = pool.filter((a) => a.email !== email);
    await writePool(next);
    return { total: next.length };
  });

  ipcMain.handle(CH.archiveList, async (_e, opts) => {
    const store = getStore();
    if (store) {
      const index = await store.list(opts || undefined);
      return (index.items || []).map((c) => ({
        id: c.uuid,
        email: c.email || "saved",
        orgName: null,
        capturedAt: c.capturedAt,
        updatedAt: c.updatedAt || c.capturedAt,
        count: c.messageCount || 0,
        name: c.name || "Untitled",
      }));
    }
    return listArchives();
  });

  ipcMain.handle(CH.archiveGet, async (_e, id) => {
    const store = getStore();
    if (store) {
      const conv = await store.get(id);
      if (!conv) return null;
      return {
        id: conv.uuid,
        email: conv.email || "saved",
        orgName: null,
        capturedAt: conv.capturedAt,
        count: conv.messageCount || 0,
        conversations: [
          {
            uuid: conv.uuid,
            name: conv.name,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messages: conv.messages || [],
          },
        ],
      };
    }
    const safe = String(id).replace(/[^a-zA-Z0-9-]/g, "");
    return readJson(path.join(rootDir, "archive", `${safe}.json`), null);
  });

  ipcMain.handle(CH.archiveCapture, async () => {
    // A manual save must work even when the account is unhealthy: that is
    // exactly when the chats are about to be lost.
    const store = getStore();
    if (store) {
      const result = await store.captureQuiet({ email: cfg.currentEmail, allAccounts: true });
      if (!result?.ok) throw new Error(result?.reason || "capture failed");
      return { id: result.email, count: result.conversations || 0 };
    }
    const key = await currentSessionKey();
    if (!key) throw new Error("not signed in");
    const info = await claudeAccountInfo(key);
    if (!info.ok) throw new Error("session invalid");
    const archive = await archiveAccount({
      sessionKey: key,
      email: (await readAccounts())[0]?.email,
      emit,
    });
    return { id: archive.id, count: archive.count };
  });

  ipcMain.handle(CH.archiveDelete, async (_e, id) => {
    const store = getStore();
    if (store) {
      await store.remove(id);
      return { ok: true };
    }
    const safe = String(id).replace(/[^a-zA-Z0-9-]/g, "");
    await fsp.unlink(path.join(rootDir, "archive", `${safe}.json`)).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle(CH.localChatsList, async (_e, opts) => {
    const store = getStore();
    return store ? store.listForSidebar(opts || undefined) : [];
  });

  ipcMain.handle(CH.localChatGet, async (_e, uuid) => {
    const store = getStore();
    return store ? store.getRaw(uuid) : null;
  });

  ipcMain.handle(CH.localChatSave, async (_e, raw) => {
    const store = getStore();
    if (!store || !raw) return { ok: false };
    await store.saveRaw(raw, cfg.currentEmail);
    return { ok: true };
  });

  ipcMain.handle(CH.localChatAliasGet, async (_e, payload) => {
    const store = getStore();
    if (!store || !payload?.orgUuid || !payload?.oldUuid) return null;
    return store.getAlias(payload.orgUuid, payload.oldUuid);
  });

  ipcMain.handle(CH.localChatAliasSet, async (_e, payload) => {
    const store = getStore();
    if (!store || !payload?.orgUuid || !payload?.oldUuid || !payload?.newUuid) return null;
    return store.setAlias(payload.orgUuid, payload.oldUuid, payload.newUuid);
  });

  ipcMain.handle(CH.localChatRename, async (_e, payload) => {
    const store = getStore();
    if (!store || !payload?.uuid) return null;
    return store.rename(payload.uuid, payload.name);
  });

  ipcMain.handle(CH.localChatDelete, async (_e, uuid) => {
    const store = getStore();
    if (!store || !uuid) return false;
    await store.remove(uuid);
    return true;
  });

  ipcMain.handle(CH.clientLog, async (_e, msg, data) => {
    log(String(msg || "[client]"), data || {});
    return true;
  });

  // Install the renderer fetch/XHR hook in the page's MAIN world. The overlay
  // itself runs in an isolated world, so its own webFrame.executeJavaScript
  // cannot patch the fetch the web app actually calls. Main-process
  // webContents.executeJavaScript always targets the main world.
  ipcMain.on(CH.injectMain, (e, code) => {
    try {
      if (typeof code !== "string" || !code.length || code.length > 4_000_000) {
        log("[inject] rejected payload", { type: typeof code, len: code ? String(code).length : 0 });
        return;
      }
      const wc = e.sender;
      if (!wc || wc.isDestroyed()) return;
      Promise.resolve(wc.executeJavaScript(code, true))
        .then(() => {
          if (wc.isDestroyed()) return;
          const probe =
            "({ok:true,hooked:!!window.__formaFetchHooked,isForma:!!(window.fetch&&window.fetch.__isFormaFetch)})";
          return Promise.resolve(wc.executeJavaScript(probe, true))
            .then((out) => {
              if (!wc.isDestroyed()) log("[inject] result", { url: String(wc.getURL() || "").slice(0, 90), out: out || null });
            })
            .catch(() => {});
        })
        .catch((err) => log("[inject] failed", { message: String(err?.message || err) }));
    } catch (err) {
      log("[inject] threw", { message: String(err?.message || err) });
    }
  });

  ipcMain.handle(CH.sessionInfo, async () => {
    const key = await currentSessionKey();
    if (!key) return { signedIn: false };
    const info = await claudeAccountInfo(key);
    return {
      signedIn: info.ok,
      orgs: info.orgs?.map((o) => ({ uuid: o.uuid, name: o.name })) || [],
    };
  });

  ipcMain.handle(CH.warp, async () => {
    const st = await warpStatus(true);
    const ip = st.available && st.connected ? await proxiedIp() : null;
    return { available: st.available, connected: st.connected, port: st.port, ip };
  });

  ipcMain.handle(CH.warpRotate, async () => {
    try {
      return await warpRotate();
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle(CH.openExternal, async (_e, url) => {
    const { shell } = require("electron");
    if (typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)?(claude\.ai|claude\.com)\//i.test(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  const requireAgentLicense = () => {
    if (forma?.license && forma.license.snapshot?.()?.status !== "active") {
      throw new Error("Forma Claude license is not active.");
    }
  };

  ipcMain.handle(CH.agentState, async () => {
    const a = getAgent();
    return a ? a.getState() : { enabled: false, error: formaAgentError || "Agent engine unavailable" };
  });

  ipcMain.handle(CH.agentSetConfig, async (_e, patch) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error(formaAgentError || "Agent unavailable");
    return a.setConfig(patch);
  });

  ipcMain.handle(CH.agentPickWorkspace, async (e) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error(formaAgentError || "Agent unavailable");
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    return a.pickWorkspace(win);
  });

  ipcMain.handle(CH.agentOpenWorkspace, async () => {
    const a = getAgent();
    if (a) await a.openWorkspace();
    return { ok: !!a };
  });

  ipcMain.handle(CH.agentPromptHeader, async () => {
    const a = getAgent();
    if (!a) {
      log("[agent] header skipped: no agent", { err: formaAgentError || null });
      return null;
    }
    const st = a.getState();
    if (!st.enabled) {
      log("[agent] header skipped: disabled");
      return null;
    }
    return { header: await a.buildPromptHeader(), mode: st.mode, toolsCount: st.toolsCount };
  });

  ipcMain.handle(CH.agentExec, async (e, payload) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error(formaAgentError || "Agent unavailable");
    return a.executeToolBatch(e.sender, payload || {});
  });

  ipcMain.handle(CH.agentStop, async (_e, chatId) => {
    const a = getAgent();
    return a ? a.stopAll(chatId) : { ok: false };
  });

  ipcMain.handle(CH.agentResetShell, async (_e, chatId) => {
    const a = getAgent();
    return a ? a.resetShell(chatId) : { ok: false };
  });

  ipcMain.handle(CH.agentSkillCreate, async (_e, args) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.createSkill(args);
  });

  ipcMain.handle(CH.agentSkillActivate, async (_e, id) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.activateSkill(id);
  });

  ipcMain.handle(CH.agentSkillRemove, async (_e, id) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.removeSkill(id);
  });

  ipcMain.handle(CH.agentMcpUpsert, async (_e, args) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.upsertMcp(args);
  });

  ipcMain.handle(CH.agentMcpConnect, async (_e, id) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.connectMcp(id);
  });

  ipcMain.handle(CH.agentMcpRemove, async (_e, id) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.removeMcp(id);
  });

  ipcMain.handle(CH.agentTree, async (_e, relPath) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.workspaceTree(relPath || ".");
  });

  ipcMain.handle(CH.agentReadPreview, async (_e, relPath) => {
    requireAgentLicense();
    const a = getAgent();
    if (!a) throw new Error("Agent unavailable");
    return a.workspaceRead(relPath);
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function boot() {
  initPaths();
  loadConfigSync();
  log = (...args) => {
    try {
      fs.appendFileSync(
        path.join(rootDir, "logs", "forma-reset.log"),
        `[${nowIso()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
      );
    } catch {
      /* logging must never break the app */
    }
  };
  log("boot", { version: app.getVersion(), root: rootDir });
  registerIpc();
  app.whenReady().then(() => {
    try {
      const ses = claudeSession();
      if (ses && ses.webRequest && !ses.__formaNetLogged) {
        ses.__formaNetLogged = true;
        const wr = ses.webRequest;
        const wrapNotify = (methodName, ourFn) => {
          const orig = wr[methodName].bind(wr);
          let appFilter = null;
          let appFn = null;
          const dispatch = (details) => {
            try { ourFn(details); } catch {}
            if (typeof appFn === "function") {
              try {
                // Honour app's optional { urls } filter loosely when present
                if (!appFilter || !Array.isArray(appFilter.urls) || details.url) {
                  appFn(details);
                }
              } catch {}
            }
          };
          orig(dispatch);
          wr[methodName] = (a, b) => {
            if (typeof a === "function") { appFilter = null; appFn = a; }
            else if (typeof b === "function") { appFilter = a; appFn = b; }
            else { appFilter = null; appFn = null; }
            orig(dispatch);
          };
        };
        wrapNotify("onCompleted", (details) => {
          if (details.method === "POST" && /chat_conversations|completion/i.test(details.url)) {
            log("[net-post]", { code: details.statusCode, wcId: details.webContentsId, url: details.url.slice(0, 160), type: details.resourceType });
          }
          if (details.statusCode >= 400 && /\/(?:api|v1|v2|chat)\//i.test(details.url)) {
            log("[net-4xx]", {
              code: details.statusCode,
              method: details.method,
              type: details.resourceType,
              url: details.url.slice(0, 180),
            });
          }
        });
        wrapNotify("onErrorOccurred", (details) => {
          if (/\/(?:api|v1|v2)\//i.test(details.url) && details.error !== "net::ERR_ABORTED") {
            log("[net-err]", {
              err: details.error,
              method: details.method,
              type: details.resourceType,
              url: details.url.slice(0, 180),
            });
          }
        });
      }
    } catch {}
    try { getAgent(); } catch {}
  });
  app.on("before-quit", () => {
    try { agentCtrl?.dispose?.(); } catch {}
  });

  // Forma Claude core: license, sealed module, chat store, updater.
  app.whenReady().then(async () => {
    if (!installFormaClaude) {
      log("[forma] core module missing", { error: formaModuleError || "not found" });
      return;
    }
    try {
      const { safeStorage } = require("electron");
      forma = await installFormaClaude({
        app,
        ipcMain,
        safeStorage,
        rootDir,
        appRoot: path.dirname(app.getPath("exe")),
        getSessionKey: currentSessionKey,
        getAccounts: readAccounts,
        log,
        appVersion: app.getVersion(),
      });
      const snap = forma.license.snapshot();
      log("[forma] license core ready", { status: snap.status, device: String(snap.device || "").slice(0, 8) });
    } catch (err) {
      log("[forma] install failed", { error: String(err?.message || err) });
    }
  });

  // Keep saving the current account's chats while the app runs.
  app.whenReady().then(() => startAutoCapture());

  // Opt-in harness: lets the whole signup path be exercised without touching
  // the UI. Harmless when the flag file is absent.
  app.whenReady().then(() => setTimeout(() => runSelfTest().catch(() => {}), 3000));

  // Opt-in renderer probe (touch <root>/debug.flag): logs whether the overlay
  // actually mounted, which is otherwise invisible from the main process.
  app.whenReady().then(() => {
    const flag = path.join(rootDir, "debug.flag");
    if (!fs.existsSync(flag)) return;
    const probe = `(() => {
      const q = (s) => !!document.querySelector(s);
      const pm = document.querySelector(".ProseMirror");
      const btn = document.getElementById("fr-btn");
      const r = btn ? btn.getBoundingClientRect() : null;
      const diag = [];
      if (pm) {
        const pr = pm.getBoundingClientRect();
        diag.push("pm:" + Math.round(pr.x) + "," + Math.round(pr.y) + "," + Math.round(pr.width) + "x" + Math.round(pr.height));
        let n = pm;
        for (let i = 0; i < 9 && n.parentElement; i += 1) {
          n = n.parentElement;
          const nr = n.getBoundingClientRect();
          diag.push(
            i + ":" + n.tagName + "." + String(n.className || "").slice(0, 28) +
            " h=" + Math.round(nr.height) + " btns=" + n.querySelectorAll("button").length,
          );
        }
        const all = Array.prototype.slice.call(document.querySelectorAll("button")).map((b) => {
          const br = b.getBoundingClientRect();
          return { t: (b.textContent || "").trim().slice(0, 14), x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) };
        }).filter((b) => b.w > 8 && b.h > 8 && b.y > pr.bottom - 40);
        diag.push("below:" + JSON.stringify(all.slice(0, 14)));
      }
      return {
        href: location.href.slice(0, 90),
        ready: document.readyState,
        root: q("#fr-root"),
        btn: !!btn,
        lock: q("#fr-lock"),
        arch: q("#fr-arch"),
        btnBox: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
        btnDisplay: btn ? getComputedStyle(btn).display : null,
        pm: !!pm,
        fetchHooked: !!window.__formaFetchHooked,
        fetchIsForma: !!(window.fetch && window.fetch.__isFormaFetch),
        buttons: document.querySelectorAll("button").length,
        scripts: document.scripts.length,
        diag,
      };
    })()`;
    let round = 0;
    const timer = setInterval(async () => {
      round += 1;
      let list = [];
      try {
        list = webContents.getAllWebContents();
      } catch {
        list = [];
      }
      for (const wc of list) {
        if (wc.isDestroyed()) continue;
        try {
          const prefs = wc.getLastWebPreferences?.() || {};
          const out = await wc.executeJavaScript(probe, true);
          log("[probe]", {
            round,
            id: wc.id,
            type: wc.getType?.(),
            preload: prefs.preload ? String(prefs.preload).split(/[\\/]/).slice(-2).join("/") : null,
            sandbox: prefs.sandbox,
            ...out,
          });
        } catch (err) {
          log("[probe]", { round, id: wc.id, type: wc.getType?.(), error: err?.message || String(err) });
        }
      }
      if (round >= 4) clearInterval(timer);
    }, 4000);
  });
}

try {
  boot();
} catch (err) {
  // Never let the overlay take the desktop app down.
  try {
    process.stderr.write(`[forma-reset] boot failed: ${err?.message}\n`);
  } catch {
    /* stderr closed */
  }
}

module.exports = { CH };
