// Fake MetaApi for testing the app without a real account: node tools/mock-server.mjs [port]
// Open the app with ?api=http://localhost:PORT and any token. Visit /mock/configure/<accountId> to
// simulate a follower entering their login. Server name "bad" returns a server-not-found error; "slow" answers 202 twice first.
import http from 'node:http';
const port = Number(process.argv[2] || 8787);
const accounts = []; const strategies = []; const subscribers = [];
let n = 0; const pending = {};
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE', 'Access-Control-Allow-Headers': 'auth-token,content-type,transaction-id' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : undefined;
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const m = req.method;
  if (m === 'OPTIONS') return send(res, 204);
  if (p.startsWith('/mock/configure/')) {
    const a = accounts.find((x) => x._id === p.split('/').pop());
    if (!a) return send(res, 404, { message: 'no account' });
    Object.assign(a, { login: String(10000 + ++n), state: 'DEPLOYED', connectionStatus: 'CONNECTED' });
    return send(res, 200, a);
  }
  if (req.headers['auth-token'] === 'bad') return send(res, 401, { message: 'Unauthorized' });
  let r;
  if (p === '/users/current/regions') return send(res, 200, ['new-york']);
  if (p === '/users/current/servers/mt-client-api') return send(res, 200, { domain: 'agiliumtrade.ai' });
  if (p === '/users/current/accounts' && m === 'GET') return send(res, 200, accounts);
  if (p === '/users/current/accounts' && m === 'POST') {
    if (body.server === 'bad') return send(res, 400, { message: 'Server not found', details: { code: 'E_SRV_NOT_FOUND', serversByBrokers: { 'FP Markets': ['FPMarketsSC-Live', 'FPMarketsSC-Demo'] } } });
    if (body.server === 'slow' && (pending[req.headers['transaction-id']] = (pending[req.headers['transaction-id']] || 0) + 1) < 3) return send(res, 202, { message: 'Account connection validation is in progress, please retry in 2 seconds (x)' });
    const a = { _id: 'acc' + ++n, ...body, state: body.login ? 'DEPLOYED' : 'DRAFT', connectionStatus: body.login ? 'CONNECTED' : 'DISCONNECTED' };
    delete a.password; accounts.push(a);
    return send(res, 201, { id: a._id, state: a.state });
  }
  if ((r = p.match(/^\/users\/current\/accounts\/([^/]+)\/configuration-link$/))) return send(res, 200, { configurationLink: `http://localhost:${port}/mock/configure/${r[1]}` });
  if ((r = p.match(/^\/users\/current\/accounts\/([^/]+)\/deploy$/))) { const a = accounts.find((x) => x._id === r[1]); a.state = 'DEPLOYED'; a.connectionStatus = 'CONNECTED'; return send(res, 204); }
  if ((r = p.match(/^\/users\/current\/accounts\/([^/]+)$/))) {
    const i = accounts.findIndex((x) => x._id === r[1]);
    if (i < 0) return send(res, 404, { message: 'Not found' });
    if (m === 'DELETE') { accounts.splice(i, 1); return send(res, 204); }
    return send(res, 200, accounts[i]);
  }
  if (p === '/users/current/configuration/unused-strategy-id') return send(res, 200, { id: 'S' + ++n });
  if (p === '/users/current/configuration/strategies') return send(res, 200, strategies);
  if ((r = p.match(/^\/users\/current\/configuration\/strategies\/([^/]+)$/)) && m === 'PUT') { strategies.push({ _id: r[1], ...body }); return send(res, 204); }
  if (p === '/users/current/configuration/subscribers') return send(res, 200, subscribers);
  if ((r = p.match(/^\/users\/current\/configuration\/subscribers\/([^/]+)$/))) {
    const i = subscribers.findIndex((x) => x._id === r[1]);
    if (m === 'DELETE') { if (i >= 0) subscribers.splice(i, 1); return send(res, 204); }
    const s = { _id: r[1], ...body }; if (i >= 0) subscribers[i] = s; else subscribers.push(s);
    return send(res, 204);
  }
  if (/\/stopouts$/.test(p)) return send(res, 200, []);
  if (/\/user-log$/.test(p)) return send(res, 200, [{ time: new Date().toISOString(), level: 'INFO', symbol: 'EURUSD', side: 'buy', message: 'copied 0.10 lots' }]);
  send(res, 404, { message: 'mock: unknown ' + m + ' ' + p });
}).listen(port, () => console.log('mock MetaApi on http://localhost:' + port));
