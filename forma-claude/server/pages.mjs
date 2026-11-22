/**
 * Forma Claude — public pages.
 *
 * One design system, three states: key, result, error.
 * No frameworks, no gradients, no emoji. System stack, one accent, hairline
 * rules, and a single purposeful animation that respects reduced motion.
 */

const CSS = `
:root{
  --bg:#0b0b0c; --fg:#ecebe8; --mut:#8a8886; --dim:#5f5d5b;
  --line:rgba(236,235,232,.12); --line2:rgba(236,235,232,.24);
  --acc:#c96442; --bad:#c0645a; --ok:#7ba17b;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{
  background:var(--bg); color:var(--fg);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  display:flex; align-items:center; justify-content:center;
  padding:40px 24px; min-height:100vh;
}
.wrap{width:100%; max-width:452px}
.card{border:1px solid var(--line); border-radius:14px; padding:34px 32px 30px; background:rgba(255,255,255,.012);
  animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.mark{display:block; width:46px; height:46px; margin:0 0 26px}
.mark .bar{stroke:var(--fg); stroke-width:3.4; stroke-linecap:round; fill:none;
  stroke-dasharray:40; stroke-dashoffset:40; animation:draw .5s cubic-bezier(.2,.7,.2,1) forwards}
.mark .b1{animation-delay:.05s}
.mark .b2{animation-delay:.16s}
.mark .b3{animation-delay:.27s}
.mark .rule{fill:var(--acc); opacity:0; animation:fade .35s ease .48s forwards, breathe 3.4s ease-in-out 1s infinite}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fade{to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.55}}
@media (prefers-reduced-motion: reduce){
  .card{animation:none}
  .mark .bar,.mark .rule{animation:none; stroke-dashoffset:0; opacity:1}
  .steps li{animation:none; opacity:1}
}
h1{margin:0 0 8px; font-size:19px; font-weight:600; letter-spacing:-.017em}
.lede{margin:0 0 26px; color:var(--mut); font-size:13.5px; max-width:36ch}
.steps{list-style:none; margin:0 0 26px; padding:0}
.steps li{display:flex; gap:12px; align-items:flex-start; margin-bottom:13px; font-size:13.5px; color:var(--mut);
  animation:rise .45s cubic-bezier(.2,.7,.2,1) both}
.steps li:nth-child(1){animation-delay:.10s}
.steps li:nth-child(2){animation-delay:.18s}
.steps li:nth-child(3){animation-delay:.26s}
.steps li:nth-child(4){animation-delay:.34s}
.steps .n{flex:0 0 20px; height:20px; border:1px solid var(--line2); border-radius:6px;
  font:11px/18px ui-monospace,SFMono-Regular,Consolas,monospace; text-align:center; color:var(--dim)}
.steps b{color:var(--fg); font-weight:500}
.cta{display:block; width:100%; text-align:center; text-decoration:none; background:var(--fg); color:#111;
  border:0; border-radius:9px; padding:12px; font:inherit; font-weight:600; cursor:pointer;
  transition:opacity .14s ease, transform .14s ease}
.cta:hover{opacity:.9}
.cta:active{transform:scale(.995)}
.cta.ghost{background:transparent; color:var(--fg); border:1px solid var(--line2); margin-top:9px}
.cta.ghost:hover{border-color:rgba(236,235,232,.38)}
.meta{margin-top:22px; padding-top:18px; border-top:1px solid var(--line);
  color:var(--dim); font-size:11.5px; display:flex; justify-content:space-between; gap:12px}
.keybox{position:relative; margin:0 0 10px}
textarea{width:100%; min-height:104px; resize:none; background:#111112; color:var(--fg);
  border:1px solid var(--line); border-radius:10px; padding:14px;
  font:12.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace; outline:none}
textarea:focus{border-color:var(--line2)}
.copy{width:100%; background:transparent; color:var(--fg); border:1px solid var(--line2);
  border-radius:9px; padding:11px; font:inherit; font-weight:500; cursor:pointer;
  transition:border-color .14s ease, color .14s ease}
.copy:hover{border-color:rgba(236,235,232,.38)}
.copy.done{color:var(--ok); border-color:rgba(123,161,123,.45)}
.alt{margin-top:26px; padding-top:20px; border-top:1px solid var(--line)}
.alt-t{margin:0 0 4px; color:var(--fg); font-size:12.5px; font-weight:500}
.alt-s{margin:0 0 12px; color:var(--dim); font-size:11.5px}
.alt input{width:100%; background:#111112; color:var(--fg); border:1px solid var(--line);
  border-radius:9px; padding:10px 12px; font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;
  outline:none; margin-bottom:9px}
.alt input:focus{border-color:var(--line2)}
.alt input::placeholder{color:#3f3e3d}
.alt .notice{margin:10px 0 0}
.notice{margin:0 0 20px; padding:11px 13px; border:1px solid rgba(192,100,90,.32);
  border-radius:9px; color:var(--bad); font-size:12.5px}
.notice.ok{border-color:rgba(123,161,123,.32); color:var(--ok)}
h1.bad{color:var(--bad)}
.foot{margin-top:18px; color:var(--dim); font-size:11.5px; text-align:center}
`;

/** The Forma mark: an F drawn in three strokes, with one terracotta rule. */
function mark() {
  return `<svg class="mark" viewBox="0 0 48 48" role="img" aria-label="Forma">
  <path class="bar b1" d="M12 10h24"/>
  <path class="bar b2" d="M12 22.5h15"/>
  <path class="bar b3" d="M12 10v28"/>
  <rect class="rule" x="12" y="41" width="24" height="2.4" rx="1.2"/>
</svg>`;
}

const shell = (title, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<style>${CSS}</style>
</head><body><div class="wrap"><div class="card">${body}</div></div></body></html>`;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Shared copy-to-clipboard behaviour for the key textarea. */
function copyScript() {
  return `<script>
  const btn = document.getElementById('copy');
  btn.addEventListener('click', async () => {
    const el = document.getElementById('key');
    try {
      await navigator.clipboard.writeText(el.value);
    } catch {
      el.select();
      document.execCommand && document.execCommand('copy');
    }
    btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = 'Copy key'; btn.classList.remove('done'); }, 1800);
  });
  document.getElementById('key').addEventListener('click', (e) => e.target.select());
</script>`;
}

function downloadCta(download) {
  return download
    ? `<a class="cta ghost" href="${esc(download)}">Download Forma Claude</a>`
    : '';
}

/**
 * Shown when the installation already holds a live key. The checkpoint is not
 * repeated: the same key is handed back and keeps renewing itself.
 */
export function existingPage(key, meta = {}, { download = '/download' } = {}) {
  const until = meta.expiresAt ? new Date(meta.expiresAt) : null;
  const valid = until
    ? `Valid until ${esc(until.toUTCString())}. It renews automatically while Forma Claude is open.`
    : 'It renews automatically while Forma Claude is open.';
  return shell(
    'Forma Claude — your key',
    `${mark()}
<h1>Your key is still active</h1>
<p class="lede">${valid}</p>
<div class="keybox"><textarea id="key" readonly spellcheck="false">${esc(key)}</textarea></div>
<button class="copy" id="copy">Copy key</button>
${downloadCta(download)}
<a class="cta ghost" href="/get-key">Back to the key page</a>
<div class="meta"><span>5-hour rolling window</span><span>One device</span></div>
${copyScript()}`,
  );
}

export function keyPage({ checkpoint = 'linkvertise', cooldown = null, notice: extra = '', download = '/download' } = {}) {
  const notice = cooldown
    ? `<div class="notice">A key was already issued for this installation. Try again after ${esc(cooldown)}.</div>`
    : extra
      ? `<div class="notice">${esc(extra)}</div>`
      : '';

  const step2 =
    checkpoint === 'direct'
      ? 'Continue to the key.'
      : 'Open the checkpoint and finish the short ad page.';

  const fallback =
    checkpoint === 'direct'
      ? ''
      : `<div class="alt">
  <p class="alt-t">Landed somewhere else after the checkpoint?</p>
  <p class="alt-s">Paste the address you landed on. It contains the checkpoint hash.</p>
  <input id="landed" type="text" spellcheck="false" autocomplete="off" placeholder="https://…?hash=…">
  <button class="copy" id="claim">Get my key</button>
  <div class="notice" id="claimErr" hidden></div>
</div>`;

  return shell(
    'Forma Claude — get a key',
    `${mark()}
<h1>Forma Claude</h1>
<p class="lede">Limit Reset for Claude Desktop, with your chats archived before every switch.</p>
${notice}
<ol class="steps">
  <li><span class="n">1</span><span>${esc(step2)}</span></li>
  <li><span class="n">2</span><span>If the new tab does not come back here, paste the address it landed on.</span></li>
  <li><span class="n">3</span><span>Copy the <b>FORMA1</b> key into the Forma Claude lock screen.</span></li>
</ol>
<a class="cta" id="go" href="/get-key/start" target="_blank" rel="noopener">Open the checkpoint</a>
${downloadCta(download)}
${fallback}
<div class="meta"><span>5-hour rolling window</span><span>Renews while in use</span></div>
<script>
  const params = new URLSearchParams(location.search);
  const install = params.get('installation') || '';
  document.getElementById('go').href =
    '/get-key/start' + (install ? '?installation=' + encodeURIComponent(install) : '');

  const landed = document.getElementById('landed');
  const claim = document.getElementById('claim');
  const err = document.getElementById('claimErr');
  function fail(text) {
    err.textContent = text;
    err.hidden = false;
  }
  if (claim) claim.addEventListener('click', () => {
    const raw = String(landed.value || '').trim();
    if (!raw) return fail('Paste the address you landed on.');
    let hash = '';
    try {
      hash = new URL(raw).searchParams.get('hash') || '';
    } catch (e) {
      hash = raw;
    }
    if (!hash) return fail('That address has no hash in it. Copy the whole address from the bar.');
    location.href = '/get-key/claim?hash=' + encodeURIComponent(hash);
  });
</script>`,
  );
}

export function resultPage(key, checkpoint = {}, { download = '/download' } = {}) {
  return shell(
    'Forma Claude — your key',
    `${mark()}
<h1>Your key is ready</h1>
<p class="lede">Paste it into the lock screen. It binds to this device the first time it is used and stays valid while Forma Claude is in use.</p>
<div class="keybox"><textarea id="key" readonly spellcheck="false">${esc(key)}</textarea></div>
<button class="copy" id="copy">Copy key</button>
${downloadCta(download)}
<a class="cta ghost" href="/get-key">Get another key</a>
<div class="foot">${checkpoint?.tier ? `Tier ${esc(checkpoint.tier)} · ` : ''}Keep it private. Anyone with the key can claim it.</div>
${copyScript()}`,
  );
}

export function errorPage(message, hint = '') {
  return shell(
    'Forma Claude — checkpoint',
    `${mark()}
<h1 class="bad">That checkpoint did not go through</h1>
<p class="lede">${esc(message)}</p>
${hint ? `<p class="lede" style="color:var(--dim);font-size:12.5px">${esc(hint)}</p>` : ''}
<a class="cta" href="/get-key">Start again</a>`,
  );
}

export function notFoundPage() {
  return shell(
    'Forma Claude',
    `${mark()}
<h1>Nothing here</h1>
<p class="lede">This address is not a Forma Claude page. Start at the key site.</p>
<a class="cta" href="/get-key">Go to get a key</a>`,
  );
}
