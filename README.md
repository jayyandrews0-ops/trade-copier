# Trade Copier

iPhone web app that copies every trade from your MT5 **master** account (e.g. FP Markets) to **follower** MT5 accounts, using [MetaApi CopyFactory](https://metaapi.cloud/docs/copyfactory/). Copying runs in MetaApi's cloud 24/7 — nobody needs an EA, a laptop or the app open.

Plain HTML/CSS/JavaScript, no backend, no build step. Hosted free on GitHub Pages.

## Use it
1. Sign up at [app.metaapi.cloud](https://app.metaapi.cloud) and copy your API token.
2. Open the app in Safari → Share → **Add to Home Screen**.
3. Paste the token (saved only on your phone, never in this repo).
4. **Add master account**: your MT5 number, investor password and server.
5. **+ Add** a follower: either send them a secure link (they type their own login/password) or type their details yourself. Pick the lot size.

Copied: opens, closes, partial closes, SL/TP changes and pending orders. Followers can be paused (only closes copied) or removed.

Notes:
- Followers need their **main (trading)** password; the master only needs the investor password.
- MT5 *netting* accounts aren't supported by CopyFactory — use hedging accounts.
- Test on demo accounts first.

## Develop
```
npm test                           # unit tests (Node 20+)
node tools/mock-server.mjs 8787    # fake MetaApi
python3 -m http.server 8080        # open http://localhost:8080/?api=http://localhost:8787
```
`?api=` (test only) points the app at the mock; `?api=` with no value turns it off.
