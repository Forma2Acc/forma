/* Presentation only. The main process enforces access with signed server leases. */
(() => {
  'use strict';
  const api = window.formaLicense;
  if (!api) return;
  const standalone = document.documentElement.hasAttribute('data-license-gate');

  const panel = document.createElement('section');
  panel.id = 'forma-license-lock';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'fl-title');
  panel.innerHTML = `<div class="fl-backdrop" aria-hidden="true"></div><div class="fl-card"><header class="fl-header"><div class="fl-wordmark"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M5 23V5h18v5H10v4h10v5H10v4Z"/></svg><span>Forma</span></div><span id="fl-status" class="fl-status"><i></i><span>Checking access</span></span></header><div class="fl-intro"><div class="fl-kicker">YOUR WORKSPACE. YOUR ACCESS.</div><h1 id="fl-title">Activate Forma.</h1><p id="fl-message">Checking your installation…</p><p id="fl-banner" hidden class="fl-inline-banner"></p><div id="fl-id-box" class="fl-id-box" hidden><div class="fl-id-meta"><span class="fl-id-label">YOUR PERSONAL FORMA ID</span><span id="fl-id-code" class="fl-id-val"></span><span id="fl-id-full" class="fl-id-full"></span></div><button id="fl-copy-id" class="fl-id-copy" type="button">Copy ID</button></div></div><form id="fl-form"><label for="fl-key">Access key</label><div class="fl-input-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 10V7a3 3 0 0 0-6 0v3m-2 0h10a2 2 0 0 1 2 2v7H5v-7a2 2 0 0 1 2-2Z"/></svg><input id="fl-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your FORMA1 key" maxlength="4096" aria-describedby="fl-error"><button id="fl-show" type="button" aria-label="Show access key" aria-pressed="false">Show</button></div><p id="fl-error" role="status" aria-live="polite"></p><div class="fl-actions"><button id="fl-activate" class="fl-primary" type="submit"><span>Activate key</span><span aria-hidden="true">↗</span></button><button id="fl-get" type="button">Get a key <span aria-hidden="true">↗</span></button></div></form><div class="fl-bottom"><button id="fl-retry" type="button">Check again</button><button id="fl-dismiss" type="button" hidden>Back to app</button><span id="fl-expiry">10-hour access · Automatic verification</span></div><footer class="fl-footer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6"/></svg><p><strong>Your work stays yours.</strong><span>Chats and backups stay on this PC. Keys are encrypted for your Windows account.</span></p></footer></div>`;
  document.documentElement.append(panel);

  function formatFormaId(dev) {
    const clean = String(dev || '').trim().toUpperCase();
    if (clean.length < 8) return clean;
    return `FRM-${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
  }

  const review = document.createElement('aside');
  review.className = 'fl-review';
  review.hidden = true;
  const reviewText = document.createElement('p');
  reviewText.textContent = 'Forma paused this installation for a security review. Your chats and local files have not been removed.';
  const appealButton = document.createElement('button');
  appealButton.id = 'fl-review-appeal';
  appealButton.type = 'button';
  appealButton.textContent = 'Request a review on Discord ↗';
  review.append(reviewText, appealButton);
  panel.querySelector('.fl-bottom').before(review);

  const badge = document.createElement('button');
  badge.id = 'forma-license-badge';
  badge.type = 'button';
  badge.title = 'View access status';
  document.documentElement.append(badge);

  // Floating Global Broadcast Banner (visible inside active app when admin sets a banner)
  const globalBanner = document.createElement('div');
  globalBanner.id = 'forma-global-banner';
  globalBanner.hidden = true;
  document.documentElement.append(globalBanner);

  // Direct Admin Message card (pops cleanly inside Qwen Desktop and Launcher)
  const dmCard = document.createElement('aside');
  dmCard.id = 'forma-admin-dm';
  dmCard.hidden = true;
  dmCard.innerHTML = `<div class="fl-dm-head"><span class="fl-dm-dot"></span><strong id="fl-dm-title">Forma Administrator</strong><small id="fl-dm-time"></small></div><p id="fl-dm-body"></p><div class="fl-dm-actions"><button id="fl-dm-ack" type="button">Acknowledge</button></div>`;
  document.documentElement.append(dmCard);

  const $ = (id) => document.getElementById(id);
  let last = null,
    detail = false,
    busy = false,
    wasLocked = false,
    activeDmId = null;

  const labels = {
    checking: 'Checking access',
    active: 'Access active',
    missing: 'Activation required',
    invalid: 'Key not valid',
    expired: 'Access expired',
    offline: 'Connection needed',
    error: 'Access unavailable',
    setup: 'Service unavailable',
    'storage-error': 'Storage unavailable',
    banned: 'Access suspended',
    'security-blocked': 'Security block',
    'integrity-review': 'Integrity review',
    maintenance: 'Maintenance',
    'update-required': 'Update required',
  };

  function formatRemaining(ms) {
    const left = Math.max(0, ms);
    const days = Math.floor(left / 86400000);
    const hours = Math.floor((left % 86400000) / 3600000);
    const mins = Math.floor((left % 3600000) / 60000);
    if (days >= 2) return `${days}d ${hours}h`;
    return `${Math.floor(left / 3600000)}h ${String(mins).padStart(2, '0')}m`;
  }

  function render(state) {
    last = state;
    const locked = state.status !== 'active';
    const requiresReview = state.status === 'security-blocked' || state.status === 'integrity-review';
    document.documentElement.classList.toggle('forma-access-locked', locked);
    if (document.body) document.body.inert = locked || detail;
    panel.hidden = !standalone && !locked && !detail;
    badge.hidden = standalone || locked;
    panel.dataset.status = state.status;
    $('fl-title').textContent = locked
      ? state.status === 'checking'
        ? 'Checking access.'
        : state.status === 'expired'
          ? 'Renew your access.'
          : state.status === 'banned'
            ? 'Access suspended.'
            : state.status === 'security-blocked'
              ? 'Security check failed.'
              : state.status === 'integrity-review'
                ? 'Access paused for review.'
              : state.status === 'maintenance'
              ? 'Under maintenance.'
              : state.status === 'update-required'
                ? 'Update required.'
                : 'Activate Forma.'
      : 'Access is active.';
    $('fl-status').querySelector('span').textContent = labels[state.status] || 'Access unavailable';
    $('fl-message').textContent = state.message || 'A valid key is required to open Forma and Qwen.';
    $('fl-form').hidden = requiresReview;
    review.hidden = !requiresReview;
    $('fl-dismiss').hidden = standalone || locked;
    $('fl-expiry').textContent = requiresReview ? 'Access can be restored after support review.' : '10-hour access · Automatic verification';

    const banner = $('fl-banner');
    const bannerText = state.policy?.bannerMessage || '';
    const bannerLevel = state.policy?.bannerLevel || 'info';
    banner.hidden = !bannerText;
    banner.textContent = bannerText;
    banner.dataset.level = bannerLevel;

    const idBox = $('fl-id-box');
    const formaId = formatFormaId(state.device);
    if (idBox) {
      idBox.hidden = !formaId;
      if (formaId) {
        $('fl-id-code').textContent = formaId;
        $('fl-id-full').textContent = `${state.device.slice(0, 16)}…${state.device.slice(-8)} · Share only your Forma ID for Discord support`;
        $('fl-copy-id').dataset.copyId = formaId;
      }
    }

    globalBanner.hidden = standalone || locked || !bannerText;
    globalBanner.textContent = bannerText;
    globalBanner.dataset.level = bannerLevel;

    const dm = !locked && !standalone ? state.policy?.directMessage : null;
    if (dm && dm.id && dm.body) {
      activeDmId = dm.id;
      dmCard.hidden = false;
      dmCard.dataset.severity = dm.severity || 'info';
      $('fl-dm-title').textContent = dm.title || 'Forma Administrator';
      $('fl-dm-body').textContent = dm.body;
      $('fl-dm-time').textContent = dm.sentAt ? new Date(dm.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    } else {
      activeDmId = null;
      dmCard.hidden = true;
    }

    if (!locked && state.permanent) {
      badge.textContent = 'Admin · permanent';
      $('fl-message').textContent = 'Permanent admin access is active on this device.';
      $('fl-expiry').textContent = 'Permanent admin access · Automatic verification';
    } else if (!locked) {
      const rem = formatRemaining(state.expiresAt - Date.now());
      const prefix = state.accessType === 'timed' ? 'Timed' : 'Access';
      badge.textContent = `${prefix} · ${rem}`;
      const expiry = new Date(state.expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
      $('fl-message').textContent = `Forma and Qwen are unlocked on this installation. Access expires ${expiry}.`;
      $('fl-expiry').textContent = `${rem} remaining`;
    }
    if (locked && !wasLocked) queueMicrotask(() => (requiresReview ? appealButton : $('fl-key')).focus());
    wasLocked = locked;
  }

  async function act(fn, busyLabel = 'Checking…') {
    if (busy) return;
    busy = true;
    const activateTextEl = $('fl-activate').querySelector('span:first-child');
    const prevActivateLabel = activateTextEl ? activateTextEl.textContent : '';
    if (activateTextEl && busyLabel) activateTextEl.textContent = busyLabel;
    $('fl-error').textContent = '';
    $('fl-activate').disabled = true;
    $('fl-get').disabled = true;
    $('fl-retry').disabled = true;
    panel.setAttribute('aria-busy', 'true');
    try {
      const next = await fn();
      render(next);
      if (next && next.status && next.status !== 'active' && next.status !== 'checking') {
        $('fl-error').textContent = next.message || 'Could not activate key. Check your key and try again.';
      }
    } catch (error) {
      $('fl-error').textContent = error.message || 'The request could not be completed. Try again.';
    } finally {
      busy = false;
      if (activateTextEl) activateTextEl.textContent = prevActivateLabel || 'Activate key';
      $('fl-activate').disabled = false;
      $('fl-get').disabled = false;
      $('fl-retry').disabled = false;
      panel.removeAttribute('aria-busy');
    }
  }

  $('fl-dm-ack').onclick = async () => {
    const id = activeDmId;
    dmCard.hidden = true;
    if (id && typeof api.ackMessage === 'function') {
      await api.ackMessage(id).catch(() => {});
    }
  };

  $('fl-form').onsubmit = (event) => {
    event.preventDefault();
    const key = $('fl-key').value.trim();
    if (!key) {
      $('fl-error').textContent = 'Paste your complete access key first.';
      return;
    }
    act(async () => {
      const state = await api.activate(key);
      if (state.status === 'active') {
        $('fl-key').value = '';
        detail = false;
      }
      return state;
    }, 'Activating…');
  };
  $('fl-show').onclick = () => {
    const show = $('fl-key').type === 'password';
    $('fl-key').type = show ? 'text' : 'password';
    $('fl-show').textContent = show ? 'Hide' : 'Show';
    $('fl-show').setAttribute('aria-pressed', String(show));
    $('fl-show').setAttribute('aria-label', show ? 'Hide access key' : 'Show access key');
  };
  $('fl-get').onclick = async () => {
    try {
      await api.getKey();
      $('fl-error').textContent = 'Your browser is open. Complete the checkpoint, then paste the key here.';
    } catch (error) {
      $('fl-error').textContent = error.message;
    }
  };
  $('fl-copy-id').onclick = async () => {
    const val = $('fl-copy-id').dataset.copyId || '';
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      $('fl-copy-id').textContent = 'Copied!';
      setTimeout(() => { $('fl-copy-id').textContent = 'Copy ID'; }, 1600);
    } catch {
      $('fl-error').textContent = `Your Forma ID is ${val}`;
    }
  };
  appealButton.onclick = async () => {
    try {
      await api.openSupport();
    } catch (error) {
      $('fl-error').textContent = error.message || 'Could not open Forma Community.';
    }
  };
  $('fl-retry').onclick = () => act(() => api.check(), 'Checking…');
  $('fl-dismiss').onclick = () => {
    detail = false;
    render(last);
    badge.focus();
  };
  badge.onclick = () => {
    detail = !detail;
    render(last);
  };
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && detail && last?.status === 'active') {
      detail = false;
      render(last);
      badge.focus();
    }
  });
  api.onState(render);
  window.addEventListener('focus', async () => {
    try {
      const inp = $('fl-key');
      if (inp && !inp.value.trim() && last && last.status !== 'active' && navigator.clipboard?.readText) {
        const clip = (await navigator.clipboard.readText()).trim();
        if (/^FORMA1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clip)) {
          inp.value = clip;
          $('fl-error').textContent = 'Key detected from clipboard — click Activate key.';
        }
      }
    } catch {}
  });
  api
    .state()
    .then(render)
    .catch(() => render({ status: 'offline', message: 'Access could not be checked. Restart the app and try again.' }));
  setInterval(() => {
    if (last && last.status === 'active' && !last.permanent) render(last);
  }, 1000);
})();
