import test from 'node:test';
import assert from 'node:assert/strict';
import { MetaApi, waitText, findExisting, buildSubscriber, buildSubscription, readSubscription, validateSettings, friendlyError, followerStatus, ApiError } from '../api.js';

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (h) => (r.headers || {})[h] }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
}

test('request sends token, JSON body and query', async () => {
  const calls = [];
  const api = new MetaApi('TOK', { fetch: fakeFetch([{ status: 200, body: { configurationLink: 'L' } }], calls), copyFactoryUrl: 'https://cf' });
  assert.equal(await api.configurationLink('acc1', 7), 'L');
  assert.equal(calls[0].url, 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/acc1/configuration-link?ttlInDays=7');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['auth-token'], 'TOK');
});

test('createAccount retries on 202 and sends the same transaction-id', async () => {
  const calls = []; const waits = [];
  const api = new MetaApi('T', { fetch: fakeFetch([{ status: 202, headers: { 'retry-after': '3' }, body: { message: 'wait' } }, { status: 201, body: { id: 'x', state: 'DEPLOYED' } }], calls), sleep: async (ms) => waits.push(ms) });
  const r = await api.createAccount({ name: 'n', server: 's', platform: 'mt5' });
  assert.deepEqual(r, { id: 'x', state: 'DEPLOYED' });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [3000]);
  assert.equal(calls[0].init.headers['transaction-id'], calls[1].init.headers['transaction-id']);
  assert.equal(calls[0].init.headers['transaction-id'].length, 32);
});

test('errors become ApiError with code', async () => {
  const api = new MetaApi('T', { fetch: fakeFetch([{ status: 400, body: { message: 'bad', details: 'E_AUTH' } }], []) });
  await assert.rejects(api.getAccount('a'), (e) => e instanceof ApiError && e.code === 'E_AUTH' && e.status === 400);
});

test('copyfactory URL discovered from regions and fails over on 5xx', async () => {
  const calls = [];
  const api = new MetaApi('T', { fetch: fakeFetch([
    { status: 200, body: ['new-york', 'london'] }, { status: 200, body: { domain: 'agiliumtrade.ai' } },
    { status: 503 }, { status: 503 }, { status: 503 }, { status: 200, body: [{ _id: 's1' }] },
  ], calls), sleep: async () => {} });
  assert.deepEqual(await api.listStrategies(), [{ _id: 's1' }]);
  assert.match(calls[2].url, /^https:\/\/copyfactory-api-v1\.new-york\.agiliumtrade\.ai\/users\/current\/configuration\/strategies\?limit=1000$/);
  assert.match(calls[5].url, /copyfactory-api-v1\.london\./);
});

test('lot settings map to CopyFactory and back', () => {
  for (const s of [{ mode: 'balance', multiplier: 2, fixedLot: 0.01, paused: false }, { mode: 'same', multiplier: 1, fixedLot: 0.01, paused: true }, { mode: 'fixed', multiplier: 1, fixedLot: 0.5, paused: false }]) {
    assert.deepEqual(readSubscription(buildSubscription('S', s)), s);
  }
  assert.deepEqual(buildSubscription('S', { mode: 'fixed', fixedLot: '0.2' }), { strategyId: 'S', multiplier: 1, tradeSizeScaling: { mode: 'fixedVolume', tradeVolume: 0.2 } });
  assert.equal(buildSubscription('S', { mode: 'balance', multiplier: 1, paused: true }).closeOnly, 'by-position');
});

test('buildSubscriber keeps other settings and un-pauses', () => {
  const existing = { _id: 'a', name: 'Old', createdAt: 'x', riskLimits: [{ type: 'day' }], subscriptions: [
    { strategyId: 'S', multiplier: 1, closeOnly: 'by-position', maxTradeRisk: 0.1, tradeSizeScaling: { mode: 'balance' } },
    { strategyId: 'OTHER', multiplier: 3 }] };
  const b = buildSubscriber(existing, 'New', 'S', { mode: 'same', multiplier: 2, paused: false });
  assert.equal(b.name, 'New');
  assert.equal(b._id, undefined);
  assert.deepEqual(b.riskLimits, [{ type: 'day' }]);
  assert.equal(b.subscriptions.length, 2);
  const s = b.subscriptions.find((x) => x.strategyId === 'S');
  assert.equal(s.closeOnly, undefined);
  assert.equal(s.maxTradeRisk, 0.1);
  assert.equal(s.multiplier, 2);
  assert.deepEqual(s.tradeSizeScaling, { mode: 'none' });
  assert.deepEqual(buildSubscriber(undefined, 'N', 'S', { mode: 'balance', multiplier: 1 }), { name: 'N', subscriptions: [{ strategyId: 'S', multiplier: 1, tradeSizeScaling: { mode: 'balance' } }] });
});

test('validateSettings', () => {
  assert.equal(validateSettings({ mode: 'balance', multiplier: 1 }), null);
  assert.ok(validateSettings({ mode: 'balance', multiplier: 0 }));
  assert.ok(validateSettings({ mode: 'fixed', fixedLot: 0 }));
  assert.equal(validateSettings({ mode: 'fixed', fixedLot: 0.01 }), null);
});

test('friendlyError suggests servers', () => {
  const e = new ApiError('x', 400, { details: { code: 'E_SRV_NOT_FOUND', serversByBrokers: { 'FP Markets': ['FPMarketsSC-Live', 'FPMarketsSC-Demo'] } } });
  const f = friendlyError(e);
  assert.deepEqual(f.servers, ['FPMarketsSC-Live', 'FPMarketsSC-Demo']);
  assert.match(friendlyError(new ApiError('x', 401, {})).text, /token/);
});

test('followerStatus', () => {
  const dep = { state: 'DEPLOYED', connectionStatus: 'CONNECTED', login: '1' };
  const sub = { subscriptions: [{ strategyId: 'S' }] };
  assert.equal(followerStatus(null).key, 'missing');
  assert.equal(followerStatus({ state: 'DRAFT' }).key, 'waiting');
  assert.equal(followerStatus({ ...dep, state: 'DEPLOY_FAILED' }).key, 'failed');
  assert.equal(followerStatus({ ...dep, connectionStatus: 'DISCONNECTED' }).key, 'connecting');
  assert.equal(followerStatus(dep, undefined, 'S').key, 'unlinked');
  assert.equal(followerStatus(dep, sub, 'S').key, 'copying');
  assert.equal(followerStatus(dep, { subscriptions: [{ strategyId: 'S', closeOnly: 'by-position' }] }, 'S').key, 'paused');
  assert.equal(followerStatus(dep, sub, 'S', [{ reason: 'day-balance-difference' }]).key, 'stopped-out');
});

test('202 without Retry-After header uses the wait from the message', async () => {
  const waits = []; const seen = [];
  const api = new MetaApi('T', { fetch: fakeFetch([{ status: 202, body: { message: 'Account connection validation is in progress, please retry in 60 seconds (abc)' } }, { status: 201, body: { id: 'x' } }], []), sleep: async (ms) => waits.push(ms) });
  await api.createAccount({}, (ms, msg) => seen.push(msg), 'TX');
  assert.deepEqual(waits, [60000]);
  assert.match(seen[0], /validation/);
});

test('waitText and findExisting', () => {
  assert.match(waitText(83000), /1:23/);
  const acc = [{ _id: 'a', login: '850112524', server: 'FPTrading-Live' }];
  assert.equal(findExisting(acc, '850112524', 'fptrading-live')._id, 'a');
  assert.equal(findExisting(acc, '1', 'FPTrading-Live'), null);
  assert.equal(findExisting(acc, '', 'FPTrading-Live'), null);
});
