// MetaApi + CopyFactory REST client (browser, no dependencies).
export const PROVISIONING_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
    this.code = typeof this.body.details === 'string' ? this.body.details
      : (this.body.details && this.body.details.code) || this.body.error || '';
  }
}

const RETRYABLE = new Set([500, 502, 503, 504]);

function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function retryAfterMs(res, body) {
  const h = res.headers && res.headers.get && res.headers.get('retry-after');
  const v = h || (body && body.metadata && body.metadata.recommendedRetryTime);
  if (v) {
    const n = Number(v);
    if (!isNaN(n)) return Math.min(Math.max(n * 1000, 1000), 60000);
    const t = new Date(v).getTime() - Date.now();
    if (!isNaN(t)) return Math.min(Math.max(t, 1000), 60000);
  }
  const m = body && typeof body.message === 'string' && body.message.match(/retry in (\d+) seconds?/i);
  if (m) return Math.min(Math.max(Number(m[1]) * 1000, 1000), 60000);
  return 10000;
}

export class MetaApi {
  constructor(token, opts = {}) {
    this.token = token;
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.provisioningUrl = opts.provisioningUrl || PROVISIONING_URL;
    this.copyFactoryUrls = opts.copyFactoryUrl ? [opts.copyFactoryUrl] : null;
    this.cfIndex = 0;
    this.maxWaitMs = opts.maxWaitMs || 5 * 60 * 1000;
  }

  async request(method, url, { body, query, headers = {}, onWait, maxWaitMs } = {}) {
    if (query) {
      const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (q.length) url += '?' + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    }
    const init = {
      method,
      headers: { 'auth-token': this.token, Accept: 'application/json', ...headers },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const started = Date.now();
    const deadline = started + (maxWaitMs || this.maxWaitMs);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, init);
      } catch (e) {
        if (attempt < 2) { await this.sleep(1500); continue; }
        throw new ApiError('Could not reach MetaApi. Check your internet connection.', 0, {});
      }
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }
      if (res.status === 202) {
        const wait = retryAfterMs(res, data);
        if (Date.now() + wait > deadline) throw new ApiError('Still checking with the broker. Tap the button again in a few minutes — it carries on where it left off.', 202, data);
        if (onWait) onWait(Date.now() - started, (data && data.message) || '');
        await this.sleep(wait);
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < 2) { await this.sleep(2000); continue; }
      if (!res.ok) throw new ApiError((data && data.message) || `MetaApi error ${res.status}`, res.status, data);
      return data;
    }
  }

  prov(method, path, opts) { return this.request(method, this.provisioningUrl + path, opts); }

  // ---- accounts ----
  async listAccounts() {
    const data = await this.prov('GET', '/users/current/accounts', { query: { limit: 1000 } });
    return Array.isArray(data) ? data : (data && data.items) || [];
  }
  getAccount(id) { return this.prov('GET', `/users/current/accounts/${id}`); }
  // Reusing the same transactionId resumes a creation that is still being validated instead of starting a new one.
  createAccount(account, onWait, transactionId = randomId(32)) {
    return this.prov('POST', '/users/current/accounts', {
      body: account, headers: { 'transaction-id': transactionId }, onWait, maxWaitMs: 15 * 60 * 1000,
    });
  }
  deployAccount(id) { return this.prov('POST', `/users/current/accounts/${id}/deploy`); }
  deleteAccount(id) { return this.prov('DELETE', `/users/current/accounts/${id}`); }
  async configurationLink(id, ttlInDays = 7) {
    const r = await this.prov('PUT', `/users/current/accounts/${id}/configuration-link`, { query: { ttlInDays } });
    return r.configurationLink;
  }

  // ---- copyfactory ----
  async cfUrls() {
    if (this.copyFactoryUrls) return this.copyFactoryUrls;
    const [regions, server] = await Promise.all([
      this.prov('GET', '/users/current/regions'),
      this.prov('GET', '/users/current/servers/mt-client-api'),
    ]);
    const domain = (server && server.domain) || 'agiliumtrade.ai';
    const list = Array.isArray(regions) && regions.length ? regions : ['new-york'];
    this.copyFactoryUrls = list.map((r) => `https://copyfactory-api-v1.${r}.${domain}`);
    return this.copyFactoryUrls;
  }
  async cf(method, path, opts) {
    const urls = await this.cfUrls();
    let lastErr;
    for (let i = 0; i < urls.length; i++) {
      const idx = (this.cfIndex + i) % urls.length;
      try {
        const r = await this.request(method, urls[idx] + path, opts);
        this.cfIndex = idx;
        return r;
      } catch (e) {
        lastErr = e;
        if (!(e.status === 0 || e.status >= 500)) throw e;
      }
    }
    throw lastErr;
  }
  async listStrategies() {
    const d = await this.cf('GET', '/users/current/configuration/strategies', { query: { limit: 1000 } });
    return Array.isArray(d) ? d : (d && d.items) || [];
  }
  async newStrategyId() { return (await this.cf('GET', '/users/current/configuration/unused-strategy-id')).id; }
  updateStrategy(id, body) { return this.cf('PUT', `/users/current/configuration/strategies/${id}`, { body }); }
  async listSubscribers() {
    const d = await this.cf('GET', '/users/current/configuration/subscribers', { query: { limit: 1000 } });
    return Array.isArray(d) ? d : (d && d.items) || [];
  }
  updateSubscriber(id, body) { return this.cf('PUT', `/users/current/configuration/subscribers/${id}`, { body }); }
  removeSubscriber(id, mode) {
    return this.cf('DELETE', `/users/current/configuration/subscribers/${id}`, { body: mode ? { mode } : undefined });
  }
  async getUserLog(id, limit = 30) {
    return (await this.cf('GET', `/users/current/subscribers/${id}/user-log`, { query: { limit } })) || [];
  }
  async getStopouts(id) { return (await this.cf('GET', `/users/current/subscribers/${id}/stopouts`)) || []; }
  resetStopout(subscriberId, strategyId, reason) {
    return this.cf('POST', `/users/current/subscribers/${subscriberId}/subscription-strategies/${strategyId}/stopouts/${reason}/reset`);
  }
}

// ---- pure helpers (unit tested) ----

export function newTransactionId() { return randomId(32); }

export function waitText(ms) {
  const sec = Math.floor(ms / 1000);
  return `Checking the login with the broker… ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}. This can take a few minutes — keep this screen open.`;
}

export function findExisting(accounts, login, server) {
  if (!login) return null;
  return accounts.find((a) => String(a.login) === String(login) && String(a.server).toLowerCase() === String(server).toLowerCase()) || null;
}

export const LOT_MODES = {
  balance: 'Match my risk (scaled to their balance)',
  same: 'Same lot size as me',
  fixed: 'Fixed lot size',
};

export function buildSubscription(strategyId, s) {
  const sub = { strategyId };
  if (s.mode === 'fixed') {
    sub.multiplier = 1;
    sub.tradeSizeScaling = { mode: 'fixedVolume', tradeVolume: Number(s.fixedLot) };
  } else {
    sub.multiplier = Number(s.multiplier) || 1;
    sub.tradeSizeScaling = { mode: s.mode === 'same' ? 'none' : 'balance' };
  }
  if (s.paused) sub.closeOnly = 'by-position';
  return sub;
}

export function readSubscription(sub) {
  if (!sub) return { mode: 'balance', multiplier: 1, fixedLot: 0.01, paused: false };
  const m = sub.tradeSizeScaling && sub.tradeSizeScaling.mode;
  return {
    mode: m === 'fixedVolume' ? 'fixed' : m === 'none' ? 'same' : 'balance',
    multiplier: sub.multiplier || 1,
    fixedLot: (sub.tradeSizeScaling && sub.tradeSizeScaling.tradeVolume) || 0.01,
    paused: !!sub.closeOnly,
  };
}

// Builds the full subscriber payload, keeping any settings made elsewhere (e.g. MetaApi dashboard).
export function buildSubscriber(existing, name, strategyId, settings) {
  const body = {};
  if (existing) {
    for (const [k, v] of Object.entries(existing)) if (!k.startsWith('_') && k !== 'removed') body[k] = v;
  }
  body.name = name || body.name || 'Follower';
  const others = (body.subscriptions || []).filter((s) => s.strategyId !== strategyId);
  const current = (existing && (existing.subscriptions || []).find((s) => s.strategyId === strategyId)) || {};
  const managed = buildSubscription(strategyId, settings);
  const merged = { ...current, ...managed };
  delete merged.removed;
  if (!settings.paused) delete merged.closeOnly;
  if (settings.mode === 'fixed') merged.multiplier = 1;
  body.subscriptions = [...others, merged];
  return body;
}

export function validateSettings(s) {
  if (s.mode === 'fixed') {
    const v = Number(s.fixedLot);
    if (!(v > 0) || v > 100) return 'Enter a fixed lot size between 0.01 and 100.';
  } else {
    const m = Number(s.multiplier);
    if (!(m > 0) || m > 100) return 'Enter a multiplier between 0.01 and 100 (1 = normal).';
  }
  return null;
}

export function friendlyError(e) {
  const code = e && e.code;
  const body = (e && e.body) || {};
  switch (code) {
    case 'E_SRV_NOT_FOUND': {
      const s = body.details && body.details.serversByBrokers;
      const names = s ? [...new Set(Object.values(s).flat())] : [];
      return { text: "That server name wasn't found. Check the exact server name in the MT5 app.", servers: names };
    }
    case 'E_AUTH':
      return { text: 'Login failed: the account number, password or server is wrong. Double-check before trying again (MetaApi can charge for repeated failed logins).' };
    case 'ERR_OTP_REQUIRED':
      return { text: 'This account has one-time passwords (OTP) turned on. Turn OTP off in the MT5 app, then try again.' };
    case 'E_PASSWORD_CHANGE_REQUIRED':
      return { text: 'The broker wants this account password changed. Change it in MT5, then try again.' };
    case 'E_TRADING_ACCOUNT_DISABLED':
      return { text: 'The broker says this account is disabled. Contact the broker.' };
    case 'E_NO_SYMBOLS':
      return { text: 'The broker has no symbols set up for this account. Contact the broker or use another account.' };
    case 'E_SERVER_TIMEZONE':
      return { text: "MetaApi couldn't read this broker's settings yet. Wait a few minutes and try again." };
    case 'E_RESOURCE_SLOTS':
      return { text: `This account needs a bigger MetaApi plan slot (${(body.details && body.details.recommendedResourceSlots) || 2}). Add it in the MetaApi dashboard instead.` };
    default:
      if (e && e.status === 401) return { text: 'Your MetaApi token is wrong or expired. Open Settings and paste a fresh token.' };
      if (e && e.status === 403) return { text: 'Your MetaApi token is missing permissions. Create a full-access API token in MetaApi.' };
      return { text: (e && e.message) || 'Something went wrong.' };
  }
}

export function followerStatus(account, subscriber, strategyId, stopouts = []) {
  if (!account) return { key: 'missing', label: 'Account missing in MetaApi', tone: 'bad' };
  if (!account.login && account.state === 'DRAFT') return { key: 'waiting', label: 'Waiting for them to enter login', tone: 'warn' };
  if (/FAILED/.test(account.state || '')) return { key: 'failed', label: 'Problem starting account', tone: 'bad' };
  if (account.state !== 'DEPLOYED') return { key: 'stopped', label: account.state === 'DEPLOYING' ? 'Starting…' : 'Not started', tone: 'warn' };
  if (account.connectionStatus !== 'CONNECTED') return { key: 'connecting', label: 'Connecting to broker…', tone: 'warn' };
  const sub = subscriber && (subscriber.subscriptions || []).find((s) => s.strategyId === strategyId && !s.removed);
  if (!sub) return { key: 'unlinked', label: 'Not copying yet', tone: 'warn' };
  if (stopouts.length) return { key: 'stopped-out', label: 'Copying stopped (risk limit)', tone: 'bad' };
  if (sub.closeOnly) return { key: 'paused', label: 'Paused (closes only)', tone: 'warn' };
  return { key: 'copying', label: 'Copying', tone: 'good' };
}
