import {
  MetaApi, newTransactionId, waitText, findExisting, buildSubscriber, readSubscription, validateSettings, friendlyError, followerStatus, LOT_MODES,
} from './api.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOKEN_KEY = 'tc_token';
const TAG = 'trade-copier';

// Test hook only: ?api=http://localhost:PORT points the app at a mock server.
const params = new URLSearchParams(location.search);
if (params.has('api')) params.get('api') ? localStorage.setItem('tc_api', params.get('api')) : localStorage.removeItem('tc_api');
const testApi = localStorage.getItem('tc_api');
const makeApi = (t) => new MetaApi(t, testApi ? { provisioningUrl: testApi, copyFactoryUrl: testApi } : {});

let api = null;
const S = { accounts: [], master: null, followers: [], strategyId: null, subscribers: [], stopouts: {}, linkErrors: {} };
let loading = false;

// ---------- helpers ----------
const roles = (a) => a.copyFactoryRoles || [];
const subscriberFor = (id) => S.subscribers.find((s) => s._id === id);
const subscriptionFor = (id) => {
  const sub = subscriberFor(id);
  return sub && (sub.subscriptions || []).find((x) => x.strategyId === S.strategyId && !x.removed);
};
function masterStatus(a) {
  if (/FAILED/.test(a.state)) return { label: 'Problem starting account', tone: 'bad' };
  if (a.state !== 'DEPLOYED') return { label: a.state === 'DEPLOYING' ? 'Starting…' : 'Not started', tone: 'warn' };
  if (a.connectionStatus !== 'CONNECTED') return { label: 'Connecting to broker…', tone: 'warn' };
  if (!S.strategyId) return { label: 'Setting up…', tone: 'warn' };
  return { label: 'Broadcasting trades', tone: 'good' };
}
function lotText(set) {
  if (set.mode === 'fixed') return `Fixed ${set.fixedLot} lots`;
  const x = Number(set.multiplier) === 1 ? '' : ` ×${set.multiplier}`;
  return (set.mode === 'same' ? 'Same lots' : 'Risk-matched') + x;
}
function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.hidden = !msg; }
function setMsg(form, text, kind = '') { const m = $('.form-msg', form); if (m) { m.textContent = text; m.className = 'form-msg ' + kind; } }
function busy(form, on) { form.querySelectorAll('button, input, select, textarea').forEach((el) => { el.disabled = on; }); }
function showError(form, e) {
  const f = friendlyError(e);
  setMsg(form, f.text, 'err');
  if (f.servers && f.servers.length && form.elements.server) {
    const box = document.createElement('div');
    box.className = 'chips';
    box.innerHTML = '<span class="hint">Did you mean:</span>' + f.servers.slice(0, 12).map((s) => `<button type="button" data-server="${esc(s)}">${esc(s)}</button>`).join('');
    box.addEventListener('click', (ev) => {
      const s = ev.target.dataset.server;
      if (s) { form.elements.server.value = s; box.remove(); setMsg(form, 'Server filled in — tap the button again.', 'ok'); }
    });
    $('.form-msg', form).after(box);
  }
}

// ---------- dialog ----------
const dlg = $('#dlg');
function openDialog(html) { $('#dlg-body').innerHTML = html; if (!dlg.open) dlg.showModal(); return $('#dlg-body'); }
function closeDialog() { if (dlg.open) dlg.close(); }
dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) closeDialog(); });

// ---------- data ----------
async function ensureStrategy() {
  const strategies = await api.listStrategies();
  const existing = strategies.find((s) => s.accountId === S.master._id && !s.removed);
  if (existing) return existing._id;
  if (S.master.state !== 'DEPLOYED') return null;
  const id = await api.newStrategyId();
  await api.updateStrategy(id, { name: `${S.master.name} (master)`, description: 'Trades copied from my master account', accountId: S.master._id });
  return id;
}

async function linkFollower(acc, settings) {
  const body = buildSubscriber(subscriberFor(acc._id), acc.name, S.strategyId, settings);
  await api.updateSubscriber(acc._id, body);
}

async function load() {
  if (!api || loading) return;
  loading = true;
  $('#btn-refresh').innerHTML = '<span class="spin">↻</span>';
  try {
    S.accounts = await api.listAccounts();
    const providers = S.accounts.filter((a) => roles(a).includes('PROVIDER'));
    S.master = providers.find((a) => (a.tags || []).includes('master')) || providers[0] || null;
    S.followers = S.accounts.filter((a) => roles(a).includes('SUBSCRIBER') && (!S.master || a._id !== S.master._id));
    S.strategyId = null;
    S.subscribers = [];
    if (S.master) {
      S.strategyId = await ensureStrategy();
      S.subscribers = await api.listSubscribers();
    }
    // Followers added by link start copying automatically once their account is running.
    if (S.strategyId) {
      for (const acc of S.followers) {
        if (acc.state === 'DEPLOYED' && !subscriberFor(acc._id) && (acc.tags || []).includes(TAG)) {
          try {
            await linkFollower(acc, (acc.metadata && acc.metadata.tc) || readSubscription(null));
            delete S.linkErrors[acc._id];
          } catch (e) { S.linkErrors[acc._id] = friendlyError(e).text; }
        }
      }
      S.subscribers = await api.listSubscribers();
    }
    const withSub = S.followers.filter((a) => subscriberFor(a._id));
    const outs = await Promise.allSettled(withSub.map((a) => api.getStopouts(a._id)));
    S.stopouts = {};
    withSub.forEach((a, i) => { S.stopouts[a._id] = outs[i].status === 'fulfilled' ? (outs[i].value || []) : []; });
    banner('');
    $('#updated').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    banner(friendlyError(e).text);
  } finally {
    loading = false;
    $('#btn-refresh').textContent = '↻';
    render();
  }
}

// ---------- rendering ----------
function render() {
  const m = $('#master');
  if (!S.master) {
    m.innerHTML = `<div class="card"><p>Add the FP Markets MT5 account you trade on. Every trade you place on it gets copied to your followers.</p>
      <button class="primary" id="btn-add-master">Add master account</button></div>`;
    $('#btn-add-master').onclick = addMasterDialog;
  } else {
    const st = masterStatus(S.master);
    m.innerHTML = `<div class="card"><button class="acct link-row" id="btn-master" style="background:none;border:none;padding:0">
      <div class="info"><div class="name">${esc(S.master.name)}</div><div class="meta">#${esc(S.master.login || '–')} · ${esc(S.master.server)}</div></div>
      <span class="pill ${st.tone}">${esc(st.label)}</span></button></div>`;
    $('#btn-master').onclick = masterDialog;
  }
  $('#btn-add-follower').hidden = !S.master;
  $('#follower-count').textContent = S.followers.length ? `(${S.followers.length})` : '';
  const f = $('#followers');
  if (!S.master) { f.innerHTML = '<p class="muted">Add your master account first.</p>'; return; }
  if (!S.followers.length) { f.innerHTML = '<div class="card muted">No followers yet. Tap “+ Add”.</div>'; return; }
  f.innerHTML = S.followers.map((a) => {
    const st = followerStatus(a, subscriberFor(a._id), S.strategyId, S.stopouts[a._id]);
    const sub = subscriptionFor(a._id);
    const set = sub ? readSubscription(sub) : ((a.metadata && a.metadata.tc) || readSubscription(null));
    return `<div class="card"><button class="acct" data-id="${esc(a._id)}" style="background:none;border:none;padding:0">
      <div class="info"><div class="name">${esc(a.name)}</div><div class="meta">#${esc(a.login || '–')} · ${esc(a.server)} · ${esc(lotText(set))}</div>
      ${S.linkErrors[a._id] ? `<div class="meta" style="color:var(--red)">${esc(S.linkErrors[a._id])}</div>` : ''}</div>
      <span class="pill ${st.tone}">${esc(st.label)}</span></button></div>`;
  }).join('');
  f.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => followerDialog(b.dataset.id); });
}

function lotFields(set) {
  return `<label>Lot size
      <select name="mode">${Object.entries(LOT_MODES).map(([k, v]) => `<option value="${k}" ${set.mode === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <p class="hint" data-hint="balance">Example: you have $10,000 and trade 1 lot; a $1,000 follower gets 0.1 lots.</p>
    <label data-for="mult">Multiplier (1 = normal, 2 = double, 0.5 = half)<input name="multiplier" type="number" inputmode="decimal" step="0.01" min="0.01" value="${esc(set.multiplier)}"></label>
    <label data-for="fixed">Lots per trade<input name="fixedLot" type="number" inputmode="decimal" step="0.01" min="0.01" value="${esc(set.fixedLot)}"></label>`;
}
function wireLotFields(form) {
  const upd = () => {
    const mode = form.elements.mode.value;
    $('[data-for="mult"]', form).hidden = mode === 'fixed';
    $('[data-for="fixed"]', form).hidden = mode !== 'fixed';
    $('[data-hint="balance"]', form).hidden = mode !== 'balance';
  };
  form.elements.mode.onchange = upd; upd();
}
const readLot = (form) => ({ mode: form.elements.mode.value, multiplier: Number(form.elements.multiplier.value), fixedLot: Number(form.elements.fixedLot.value) });

// Creates an account, resuming an unfinished attempt for the same details and never making duplicates.
async function createOnce(acct, form) {
  const existing = findExisting(await api.listAccounts(), acct.login, acct.server);
  if (existing) return { id: existing._id, existing };
  const key = `tc_tx_${acct.copyFactoryRoles[0]}_${acct.login || acct.name}@${acct.server}`.toLowerCase();
  let tx = localStorage.getItem(key);
  if (!tx) { tx = newTransactionId(); localStorage.setItem(key, tx); }
  const r = await api.createAccount(acct, (ms) => setMsg(form, waitText(ms)), tx);
  localStorage.removeItem(key);
  return r;
}

// ---------- master ----------
function addMasterDialog() {
  const body = openDialog(`<h3>Add master account</h3>
    <form id="f-master">
      <label>Name<input name="name" value="My FP Markets" required maxlength="60"></label>
      <label>MT5 account number<input name="login" inputmode="numeric" pattern="[0-9]+" required autocomplete="off"></label>
      <label>Password<input name="password" type="password" required autocomplete="off"></label>
      <p class="hint">Use your <b>investor (read-only) password</b> — copying only needs to see your trades. Your main password works too.</p>
      <label>Server (exactly as in the MT5 app)<input name="server" required autocapitalize="off" autocomplete="off" placeholder="e.g. FPMarkets-Live"></label>
      <label>Broker name<input name="broker" value="FP Markets"></label>
      <div class="btn-row"><button type="button" data-close>Cancel</button><button type="submit" class="primary">Add</button></div>
      <p class="form-msg" role="status"></p>
    </form>`);
  const form = $('#f-master', body);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    busy(form, true); setMsg(form, 'Connecting to your broker… this can take a minute or two.');
    try {
      const r = await createOnce({
        name: v.name.trim(), login: v.login.trim(), password: v.password, server: v.server.trim(), platform: 'mt5', magic: 0,
        copyFactoryRoles: ['PROVIDER'], keywords: v.broker.trim() ? [v.broker.trim()] : undefined, tags: [TAG, 'master'],
      }, form);
      if (r.existing && !roles(r.existing).includes('PROVIDER')) throw new Error('This account is already added as a follower. Remove it there first.');
      setMsg(form, 'Added! Setting up copying…', 'ok');
      await load();
      closeDialog();
    } catch (err) { busy(form, false); showError(form, err); }
  };
}

function masterDialog() {
  const a = S.master; const st = masterStatus(a);
  const body = openDialog(`<h3>${esc(a.name)}</h3>
    <p><span class="pill ${st.tone}">${esc(st.label)}</span></p>
    <p class="muted">#${esc(a.login)} · ${esc(a.server)}</p>
    <p class="hint">Trade normally in the MT5 app. Opens, closes, partial closes, SL/TP changes and pending orders are copied to every follower.</p>
    <div class="btn-row">${a.state !== 'DEPLOYED' ? '<button class="primary" id="b-deploy">Start</button>' : ''}<button data-close>Close</button></div>
    <p class="form-msg" role="status"></p>`);
  const b = $('#b-deploy', body);
  if (b) b.onclick = async () => {
    b.disabled = true;
    try { await api.deployAccount(a._id); setMsg(body, 'Starting…', 'ok'); await load(); } catch (e) { setMsg(body, friendlyError(e).text, 'err'); b.disabled = false; }
  };
}

// ---------- followers ----------
function addFollowerDialog() {
  let mode = 'link';
  const body = openDialog(`<h3>Add follower</h3>
    <div class="seg"><button type="button" data-mode="link" class="on">Send them a link</button><button type="button" data-mode="details">Enter their details</button></div>
    <form id="f-follow">
      <p class="hint" data-show="link">You'll get a secure MetaApi link to send them. They type their own login and password — you never see it.</p>
      <label>Their name<input name="name" required maxlength="60" placeholder="e.g. Sam"></label>
      <label data-show="details">MT5 account number<input name="login" inputmode="numeric" pattern="[0-9]+" autocomplete="off"></label>
      <label data-show="details">Trading (main) password<input name="password" type="password" autocomplete="off"></label>
      <p class="hint" data-show="details">Must be the main trading password — the investor password can't place trades.</p>
      <label>Their MT5 server (exactly as in their MT5 app)<input name="server" required autocapitalize="off" autocomplete="off" placeholder="e.g. FPMarkets-Live"></label>
      <label>Their broker name<input name="broker" value="FP Markets"></label>
      ${lotFields(readSubscription(null))}
      <label class="check"><input type="checkbox" name="ok" required> The account owner agreed to have trades copied</label>
      <div class="btn-row"><button type="button" data-close>Cancel</button><button type="submit" class="primary">Add follower</button></div>
      <p class="form-msg" role="status"></p>
    </form>`);
  const form = $('#f-follow', body);
  const setMode = (m) => {
    mode = m;
    body.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    body.querySelectorAll('[data-show]').forEach((el) => { el.hidden = el.dataset.show !== m; });
    form.elements.login.required = form.elements.password.required = m === 'details';
  };
  body.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  setMode('link');
  wireLotFields(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const settings = readLot(form);
    const bad = validateSettings(settings);
    if (bad) return setMsg(form, bad, 'err');
    const acct = {
      name: v.name.trim(), server: v.server.trim(), platform: 'mt5', magic: 0, copyFactoryRoles: ['SUBSCRIBER'],
      keywords: v.broker.trim() ? [v.broker.trim()] : undefined, tags: [TAG, 'follower'], metadata: { tc: settings },
    };
    if (mode === 'details') { acct.login = v.login.trim(); acct.password = v.password; }
    busy(form, true);
    setMsg(form, mode === 'details' ? 'Connecting to their broker… this can take a minute or two.' : 'Creating secure link…');
    try {
      const created = await createOnce(acct, form);
      if (created.existing && !roles(created.existing).includes('SUBSCRIBER')) throw new Error('This account is already your master account.');
      if (mode === 'link') {
        const link = await api.configurationLink(created.id, 7);
        await load();
        return showLink(acct.name, link);
      }
      if (S.strategyId) {
        try { await linkFollower({ _id: created.id, name: acct.name }, settings); } catch { /* retried automatically on refresh */ }
      }
      await load();
      closeDialog();
    } catch (err) { busy(form, false); showError(form, err); }
  };
}

function shareText(name, link) {
  return `Hi ${name}, tap this secure link and enter your MT5 account number and main (trading) password so my trades copy to your account: ${link}\nThe link works for 7 days.`;
}
function showLink(name, link) {
  const body = openDialog(`<h3>Send this link to ${esc(name)}</h3>
    <p class="hint">They open it on their phone and enter their MT5 login and main password. Copying starts automatically once they're connected.</p>
    <div class="linkbox">${esc(link)}</div>
    <div class="btn-row">${navigator.share ? '<button class="primary" id="b-share">Share…</button>' : ''}<button id="b-copy">Copy message</button></div>
    <div class="btn-row"><button data-close>Done</button></div><p class="form-msg" role="status"></p>`);
  const sb = $('#b-share', body);
  if (sb) sb.onclick = () => navigator.share({ text: shareText(name, link) }).catch(() => {});
  $('#b-copy', body).onclick = async () => {
    try { await navigator.clipboard.writeText(shareText(name, link)); setMsg(body, 'Copied — paste it into WhatsApp/iMessage.', 'ok'); } catch { setMsg(body, 'Press and hold the link above to copy it.', 'err'); }
  };
}

async function followerDialog(id) {
  const a = S.followers.find((x) => x._id === id);
  if (!a) return;
  const sub = subscriptionFor(id);
  const set = sub ? readSubscription(sub) : ((a.metadata && a.metadata.tc) || readSubscription(null));
  const st = followerStatus(a, subscriberFor(id), S.strategyId, S.stopouts[id]);
  const outs = S.stopouts[id] || [];
  const body = openDialog(`<h3>${esc(a.name)}</h3>
    <p><span class="pill ${st.tone}">${esc(st.label)}</span></p>
    <p class="muted">#${esc(a.login || '–')} · ${esc(a.server)}</p>
    ${outs.map((o) => `<div class="card"><b>Stopped:</b> ${esc(o.reasonDescription || o.reason)}<br><button class="small" data-reset="${esc(o.reason)}" data-strategy="${esc(o.strategy && o.strategy.id)}">Resume copying</button></div>`).join('')}
    <div class="btn-row">
      ${st.key === 'waiting' ? '<button class="primary" id="b-link">Get new link</button>' : '<button id="b-link">Change-password link</button>'}
      ${['stopped', 'failed'].includes(st.key) && a.login ? '<button class="primary" id="b-deploy">Start</button>' : ''}
    </div>
    <form id="f-set">
      ${lotFields(set)}
      <label class="check"><input type="checkbox" name="paused" ${set.paused ? 'checked' : ''}> Pause new trades (still closes the ones already copied)</label>
      <button type="submit" class="primary" style="width:100%">Save settings</button>
      <p class="form-msg" role="status"></p>
    </form>
    <h3 style="margin-top:16px;font-size:16px">Recent activity</h3>
    <ul class="log" id="log"><li class="muted">Loading…</li></ul>
    <div class="btn-row"><button class="danger" id="b-remove">Remove follower</button><button data-close>Close</button></div>
    <p class="form-msg" id="m-main" role="status"></p>`);
  const form = $('#f-set', body);
  const main = { querySelector: (s) => (s === '.form-msg' ? $('#m-main', body) : null) };
  wireLotFields(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const s = { ...readLot(form), paused: form.elements.paused.checked };
    const bad = validateSettings(s);
    if (bad) return setMsg(form, bad, 'err');
    if (!S.strategyId) return setMsg(form, 'Your master account is not ready yet — try again in a minute.', 'err');
    busy(form, true);
    try { await linkFollower(a, s); setMsg(form, 'Saved.', 'ok'); await load(); } catch (err) { showError(form, err); }
    busy(form, false);
  };
  $('#b-link', body).onclick = async () => {
    try { showLink(a.name, await api.configurationLink(id, 7)); } catch (e) { setMsg(main, friendlyError(e).text, 'err'); }
  };
  const dep = $('#b-deploy', body);
  if (dep) dep.onclick = async () => {
    dep.disabled = true;
    try { await api.deployAccount(id); setMsg(main, 'Starting…', 'ok'); await load(); } catch (e) { setMsg(main, friendlyError(e).text, 'err'); dep.disabled = false; }
  };
  body.querySelectorAll('[data-reset]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await api.resetStopout(id, b.dataset.strategy, b.dataset.reset); await load(); closeDialog(); } catch (e) { setMsg(main, friendlyError(e).text, 'err'); b.disabled = false; }
    };
  });
  $('#b-remove', body).onclick = () => removeDialog(a);
  const log = $('#log', body);
  if (!subscriberFor(id)) { log.innerHTML = '<li class="muted">Nothing yet.</li>'; return; }
  try {
    const items = await api.getUserLog(id, 30);
    log.innerHTML = items.length ? items.map((r) => `<li class="${esc(r.level)}">${esc(new Date(r.time).toLocaleString())} — ${esc([r.symbol, r.side].filter(Boolean).join(' '))} ${esc(r.message)}</li>`).join('') : '<li class="muted">Nothing yet.</li>';
  } catch { log.innerHTML = '<li class="muted">Could not load activity.</li>'; }
}

function removeDialog(a) {
  const hasSub = !!subscriberFor(a._id);
  const body = openDialog(`<h3>Remove ${esc(a.name)}?</h3>
    <p class="hint">This stops copying and deletes the account from MetaApi (so you stop paying for it).</p>
    <div class="btn-row" style="flex-direction:column">
      ${hasSub ? '<button class="danger" data-mode="close-immediately">Remove and close their copied trades now</button><button class="danger" data-mode="preserve">Remove and leave their trades open</button>' : '<button class="danger" data-mode="none">Remove</button>'}
      <button data-close>Cancel</button>
    </div><p class="form-msg" role="status"></p>`);
  body.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = async () => {
      body.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try {
        if (b.dataset.mode !== 'none') {
          setMsg(body, 'Stopping copying…');
          await api.removeSubscriber(a._id, b.dataset.mode);
          let gone = false;
          for (let i = 0; i < 18 && !gone; i++) {
            gone = !(await api.listSubscribers()).some((s) => s._id === a._id);
            if (!gone) await new Promise((r) => setTimeout(r, 5000));
          }
          if (!gone) {
            setMsg(body, 'Still closing their trades. Open this follower again in a few minutes and tap Remove to finish.', 'err');
            body.querySelectorAll('[data-close]').forEach((x) => { x.disabled = false; });
            return;
          }
        }
        setMsg(body, 'Deleting account…');
        await api.deleteAccount(a._id);
        await load();
        closeDialog();
      } catch (e) {
        setMsg(body, friendlyError(e).text, 'err');
        body.querySelectorAll('button').forEach((x) => { x.disabled = false; });
      }
    };
  });
}

// ---------- settings / token ----------
function settingsDialog() {
  const t = localStorage.getItem(TOKEN_KEY) || '';
  const body = openDialog(`<h3>Settings</h3>
    <p class="muted">MetaApi token: ${esc(t.slice(0, 6))}…${esc(t.slice(-4))} (saved on this phone only)</p>
    <p><a href="https://app.metaapi.cloud" target="_blank" rel="noopener">Open MetaApi dashboard</a> (billing, accounts)</p>
    <div class="btn-row" style="flex-direction:column">
      <button id="b-forget" class="danger">Forget token on this phone</button>
      <button data-close>Close</button>
    </div>
    <p class="hint">Forgetting the token does not stop copying — it keeps running in the cloud. Remove followers to stop it.</p>`);
  $('#b-forget', body).onclick = () => {
    if (!confirm('Forget the token on this phone? You will need to paste it again.')) return;
    localStorage.removeItem(TOKEN_KEY); api = null; closeDialog(); route();
  };
}

$('#form-token').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const token = form.elements.token.value.trim();
  busy(form, true); setMsg(form, 'Checking token…');
  try {
    const test = makeApi(token);
    await test.listAccounts();
    await test.cfUrls();
    localStorage.setItem(TOKEN_KEY, token);
    form.reset(); setMsg(form, '');
    route();
  } catch (err) { showError(form, err); }
  busy(form, false);
};

function route() {
  const token = localStorage.getItem(TOKEN_KEY);
  $('#view-setup').hidden = !!token;
  $('#view-home').hidden = !token;
  $('#btn-refresh').hidden = $('#btn-settings').hidden = !token;
  if (token) { api = makeApi(token); load(); }
}

$('#btn-refresh').onclick = load;
$('#btn-settings').onclick = settingsDialog;
$('#btn-add-follower').onclick = addFollowerDialog;
setInterval(() => { if (api && document.visibilityState === 'visible' && !dlg.open) load(); }, 20000);
document.addEventListener('visibilitychange', () => { if (api && document.visibilityState === 'visible') load(); });
if ('serviceWorker' in navigator && !testApi) navigator.serviceWorker.register('./sw.js').catch(() => {});
route();
