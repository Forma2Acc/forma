import crypto from 'node:crypto';

/**
 * Forma Claude — key checkpoint.
 *
 * A key is only issued after a challenge that is
 *   - signed (cannot be invented client-side)
 *   - short-lived (20 min)
 *   - single-use (the second request gets nothing)
 *   - bound to one installation and one IP
 *   - rate-limited per IP and cooled down per installation
 *
 * Three modes, chosen by configuration:
 *
 *   postback     strongest. The challenge is only completable after Linkvertise
 *                calls our postback endpoint with the shared secret. The return
 *                page alone is not enough.
 *   linkvertise  redirect to a Linkvertise link. Completion is accepted when the
 *                user returns with the challenge cookie. Single-use and
 *                cooldown still apply, but a determined user can skip the ad.
 *                This is the honest limit of a redirect-only gate.
 *   direct       no checkpoint. Development and testing only.
 *
 * Everything is server-side. The client never sees a challenge secret.
 */

const TTL_MS = 20 * 60 * 1000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input) {
  return Buffer.from(String(input), 'base64url');
}

function createCheckpointService({
  store,
  secret,
  mode = 'direct',
  linkvertiseUrl = '',
  linkvertiseToken = '',
  postbackSecret = '',
  tier = 'trial',
  cooldownMs = COOLDOWN_MS,
  ipLimitPerHour = 6,
  origin = '',
  verifyUrl = 'https://publisher.linkvertise.com/api/v1/anti_bypassing',
} = {}) {
  if (!secret) throw new Error('checkpoint secret is required');

  const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

  function issueToken(record) {
    const body = b64url(
      JSON.stringify({ id: record.id, inst: record.installation || '', exp: record.expiresAt }),
    );
    return `c1.${body}.${sign(body)}`;
  }

  function parseToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'c1') return null;
    const expected = sign(parts[1]);
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let body;
    try {
      body = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      return null;
    }
    if (!body?.id || !Number.isFinite(body.exp)) return null;
    return body;
  }

  function ipKey(ip) {
    return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 24);
  }

  function rate(ip) {
    const key = ipKey(ip);
    const bucket = store.get('checkpoint_rate', key) || { hits: [] };
    const since = Date.now() - 60 * 60 * 1000;
    bucket.hits = (bucket.hits || []).filter((t) => t > since);
    if (bucket.hits.length >= ipLimitPerHour) {
      return { ok: false, retryAt: bucket.hits[0] + 60 * 60 * 1000 };
    }
    bucket.hits.push(Date.now());
    store.put('checkpoint_rate', key, bucket);
    return { ok: true };
  }

  function grantFor(installation) {
    if (!installation) return null;
    return store.get('checkpoint_grants', String(installation)) || null;
  }

  /** The live key for an installation, if one exists. Read-only. */
  function peek(installation) {
    const grant = grantFor(installation);
    if (!grant?.keyId) return null;
    const license = store.get('licenses', grant.keyId);
    if (!license || license.revokedAt) return null;
    if (license.expiresAt && license.expiresAt <= Date.now()) return null;
    return {
      key: license.key,
      keyId: license.id,
      tier: license.tier,
      expiresAt: license.expiresAt,
    };
  }

  /**
   * Start a challenge. Returns the URL the user must visit.
   */
  async function start({ installation = '', ip = '', ua = '', origin: requestOrigin = '' } = {}) {
    const now = Date.now();

    if ((mode === 'linkvertise' || mode === 'postback') && !linkvertiseUrl) {
      return {
        ok: false,
        error: 'not_configured',
        message: 'The key checkpoint is not configured yet.',
      };
    }

    const grant = grantFor(installation);
    const base = (requestOrigin || origin || '').replace(/\/+$/, '');
    if (grant) {
      const live = peek(installation);
      if (live) {
        // The same installation already holds a live key. Hand it back instead
        // of dead-ending the user on a "try again tomorrow" page.
        return {
          ok: true,
          existing: true,
          ...live,
          mode,
          provider: 'existing',
          url: `${base}/get-key`,
        };
      }
      // The previous key lapsed on its own. A short cool-down stops a refresh
      // loop, but a fresh key is available without waiting a whole day.
      const shortCooldown = Math.min(cooldownMs, 60_000);
      if (now - grant.at < shortCooldown) {
        return {
          ok: false,
          error: 'cooldown',
          retryAt: grant.at + shortCooldown,
          message: 'Your previous key just lapsed. Try again in a minute.',
        };
      }
    }

    const limit = rate(ip);
    if (!limit.ok) {
      return { ok: false, error: 'rate_limited', retryAt: limit.retryAt, message: 'Too many attempts. Try again later.' };
    }

    const id = crypto.randomUUID();
    const record = {
      id,
      installation: String(installation || '').slice(0, 128),
      ip: ipKey(ip),
      ua: String(ua || '').slice(0, 200),
      mode,
      tier,
      createdAt: now,
      expiresAt: now + TTL_MS,
      verified: mode === 'direct',
      usedAt: null,
      keyId: null,
    };
    store.put('checkpoints', id, record);

    const token = issueToken(record);
    const returnUrl = `${base}/get-key/return?c=${encodeURIComponent(token)}`;

    let url = returnUrl;
    let provider = 'direct';

    if (mode === 'linkvertise' || mode === 'postback') {
      // One static Linkvertise link whose destination is <origin>/get-key/return.
      // Linkvertise appends ?hash=… when the user reaches the destination, and
      // the hash is what proves the ad was completed. The per-user state lives
      // in the challenge cookie, so the link itself stays static.
      provider = 'linkvertise';
      url = linkvertiseUrl;
    }

    return { ok: true, id, token, url, mode, provider, expiresAt: record.expiresAt };
  }

  /**
   * Ask Linkvertise whether a hash belongs to a completed ad.
   * https://publisher.linkvertise.com/api/v1/anti_bypassing
   */
  async function verifyHash(hash) {
    if (!linkvertiseToken) return { verified: false, state: 'not_configured' };
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(hash || ''))) {
      return { verified: false, state: 'invalid_proof' };
    }
    const url = new URL(verifyUrl);
    url.searchParams.set('token', linkvertiseToken);
    url.searchParams.set('hash', hash);
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'user-agent': 'FormaClaude/2.0' },
        signal: AbortSignal.timeout(8_000),
      });
      const body = (await res.text()).trim();
      if (res.ok && /^true$/i.test(body)) return { verified: true, state: 'verified' };
      if (/invalid token/i.test(body)) return { verified: false, state: 'invalid_configuration' };
      if (res.ok) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.status === 'boolean') {
            return { verified: parsed.status, state: parsed.status ? 'verified' : 'not_verified' };
          }
        } catch {}
      }
      return { verified: false, state: 'not_verified', status: res.status };
    } catch {
      return { verified: false, state: 'unavailable' };
    }
  }

  /**
   * Postback from the provider. Marks a challenge as genuinely completed.
   * Refuses everything without the shared secret.
   */
  function postback({ token, signature, ip = '' }) {
    if (!postbackSecret) return { ok: false, error: 'postback_disabled' };
    const body = parseToken(token);
    if (!body) return { ok: false, error: 'bad_token' };

    const expected = crypto.createHmac('sha256', postbackSecret).update(token).digest('base64url');
    const a = Buffer.from(String(signature || ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'bad_signature' };

    const record = store.get('checkpoints', body.id);
    if (!record) return { ok: false, error: 'unknown' };
    if (record.usedAt) return { ok: false, error: 'used' };
    if (record.expiresAt < Date.now()) return { ok: false, error: 'expired' };

    record.verified = true;
    record.verifiedAt = Date.now();
    record.verifiedIp = ipKey(ip);
    store.put('checkpoints', record.id, record);
    return { ok: true, id: record.id };
  }

  /**
   * Finish a challenge. Returns the challenge on success, never a key.
   */
  async function complete({ token, hash = '', ip = '' } = {}) {
    const body = parseToken(token);
    if (!body) return { ok: false, error: 'bad_token', message: 'This link is not valid.' };

    const record = store.get('checkpoints', body.id);
    if (!record) return { ok: false, error: 'unknown', message: 'This link is not valid.' };
    if (record.usedAt) return { ok: false, error: 'used', message: 'This key was already claimed.' };
    if (record.expiresAt < Date.now()) return { ok: false, error: 'expired', message: 'This link expired. Start again.' };

    // In linkvertise mode nothing is trusted until the provider confirms the
    // hash it appended to the destination.
    if (!record.verified && record.mode === 'linkvertise') {
      if (!hash) {
        return {
          ok: false,
          error: 'not_verified',
          message: 'The checkpoint was not completed.',
          state: 'missing_proof',
        };
      }
      const check = await verifyHash(hash);
      if (!check.verified) {
        return {
          ok: false,
          error: 'not_verified',
          message:
            check.state === 'invalid_configuration'
              ? 'The key checkpoint is misconfigured.'
              : 'The checkpoint was not completed.',
          state: check.state,
        };
      }
      record.verified = true;
      record.verifiedAt = Date.now();
      record.proof = String(hash).slice(0, 128);
    }

    if (!record.verified) {
      return { ok: false, error: 'not_verified', message: 'The checkpoint was not completed.' };
    }

    record.usedAt = Date.now();
    record.usedIp = ipKey(ip);
    store.put('checkpoints', record.id, record);

    if (record.installation) {
      store.put('checkpoint_grants', String(record.installation), {
        at: record.usedAt,
        checkpoint: record.id,
        tier: record.tier,
      });
    }

    return { ok: true, checkpoint: record };
  }

  /** Called after a key is minted, so the grant points at the real license. */
  function attachKey(checkpointId, keyId) {
    const record = store.get('checkpoints', checkpointId);
    if (!record) return;
    record.keyId = keyId;
    store.put('checkpoints', record.id, record);
    if (record.installation) {
      const grant = grantFor(record.installation);
      if (grant) {
        grant.keyId = keyId;
        store.put('checkpoint_grants', String(record.installation), grant);
      }
    }
  }

  function stats() {
    const all = store.all('checkpoints');
    const now = Date.now();
    return {
      total: all.length,
      completed: all.filter((c) => c.usedAt).length,
      pending: all.filter((c) => !c.usedAt && c.expiresAt > now).length,
      expired: all.filter((c) => !c.usedAt && c.expiresAt <= now).length,
      mode,
      tier,
      cooldownSeconds: Math.round(Math.min(cooldownMs, 60_000) / 1000),
      reuseExisting: true,
    };
  }

  return {
    start,
    complete,
    postback,
    verifyHash,
    attachKey,
    peek,
    stats,
    parseToken,
    mode,
    tier,
    TTL_MS,
    cooldownMs,
  };
}

export { createCheckpointService, TTL_MS, COOLDOWN_MS };
