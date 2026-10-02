# Real Monero WASM in a Chrome MV3 extension — compatibility proof

**Result: PASS with a small, audited build-time compatibility patch.** This is a disposable-wallet experiment, not a complete or audited production wallet. Everything here is confined to `experiments/wasm-mv3/`. The standalone compatibility/public-node proofs use no companion, localhost server, native messaging host or `monero-wallet-rpc`. The optional private-regtest test described below starts an isolated temporary daemon **only as a fakechain test fixture**, not as an extension runtime dependency.

## Reproduce from the repository root

Prerequisites: the already-installed `monero-ts@0.11.15`, esbuild, `@playwright/test` and Playwright Chromium.

```bash
node experiments/wasm-mv3/build.mjs
node experiments/wasm-mv3/test.mjs
```

The script loads two actual unpacked MV3 extensions in Chromium:

1. `dist-original/`: the unmodified upstream worker **fails** under MV3 CSP during real wallet creation.
2. `dist/`: the compatibility-patched upstream worker **passes** the full real wallet lifecycle below.

Both manifests enforce:

```text
script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'none';
```

There is **no `unsafe-eval`**, remote script, external WASM fetch, CDN, backend or mock wallet. The offline test aborts any HTTP(S) request and asserts that none were attempted. Browser profiles are disposable and deleted after each test. The tiny MV3 service worker exists only to discover the extension ID; the wallet runs in a **dedicated worker owned by the extension page**.

Durable evidence: `test-results.json`, `proof.png`, `build-report.json`.

## Actual wallet operations proved

- `createWalletFull` generates a new genuine **full** WASM stagenet wallet.
- Primary address comes from wallet `getAddress(0,0)`, the underlying operation for `getPrimaryAddress` (95 characters).
- Genuine 25-word recovery seed and zero atomic-unit balance.
- Account creation and subaddress derivation (index 1; a distinct valid-length address).
- `exportWalletData` maps to upstream worker `getData()`, returning `[keysData, cacheData]`. Across `postMessage`, these are **Uint8Array** values, not JSON arrays or base64 strings. Export was about 1.7 KiB keys and 419 KiB cache for this test wallet.
- Original worker is closed and **terminated**.
- A new worker rejects a wrong password, then opens the exported bytes and verifies the same address, seed, balance, accounts and subaddresses.
- A third worker restores from the seed with explicit height 0 and verifies the same address/seed/balance.
- Main-page heartbeat continues while WASM executes: latest run ~11.2 seconds, 1,122 heartbeat ticks, no JS runtime errors.
- No seed, password, key bytes, wallet address or signed transaction is printed in logs/reports/screenshots. Seed equality is checked entirely inside the extension context. No funds are involved.

### Heights on fresh offline wallets

Actual measured fresh stagenet creation:

```json
{"restoreHeight":2192256,"walletHeight":1}
```

Restoring the same seed with explicit `restoreHeight:0`:

```json
{"restoreHeight":0,"walletHeight":1}
```

The native engine estimates a restore height when creating a random wallet, despite cached/scanned height being 1. **Do not advance that to the node's current tip on the first later connection**: that could miss funds received between creation and first sync. Preserve creation time and native restore height; seed recovery must respect the user's explicit restore height.

## Minimal compatibility patch and build integration

Upstream prebuilt worker SHA256 (checked by the build script):

```text
14b9223b62d285d13f758d0e7fa88891f9492ea8e29beb7d1093f33b00c5822c
```

The prebuilt `node_modules/monero-ts/dist/monero.worker.js` already bundles its browser polyfills **and the full embedded gzip/base64 WASM engine**. A main-thread import of the SDK is unnecessary. The small adapter in `adapter.js` speaks the existing worker protocol directly:

```js
worker.postMessage([walletId, functionName, callbackId, ...args]);
// response: [walletId, callbackId, { result } | { error: serializedError }]
```

`build.mjs` copies and patches the vendor artifact, never `node_modules`:

1. Replace the two `new Function(...)` browser-detection expressions with static `typeof window` / `globalThis` predicates.
2. Replace webpack's unused legacy `new Function('return this')()` global fallback with `globalThis`.
3. Replace the library UUID helper's `Math.random` implementation with `crypto.randomUUID()`.

Each original expression/structure must occur exactly once; version, original artifact hash and absence of remaining dynamic JavaScript are checked. There is **no modification to WASM crypto**, no emulation of balances/addresses and no relaxation of MV3 CSP. Preserve upstream license files when packaging.

The WASM glue already uses static embind invokers: there is no runtime `eval`/`new Function` to fix there. It instantiates the embedded binary directly. No `PThread`/`SharedArrayBuffer` dependency was found; actual execution passed with **`crossOriginIsolated:false` and no COOP/COEP manifest settings**. Chrome extension contexts happen to expose `SharedArrayBuffer` here, but this build does not use it for its memory/threading.

### Entropy

Inspection of `monero.js`'s `initRandomFill` confirms that in the browser it calls **`crypto.getRandomValues`**. The Node-only fallback uses Node cryptographic RNG. If no cryptographic RNG exists, it aborts (`initRandomDevice`): there is **no Math.random wallet-entropy fallback** in this glue. The UUID patch is separate from wallet key entropy.

### Useful actual worker methods

| Adapter operation | Worker method / arguments |
| --- | --- |
| Create / restore | `createWalletFull`, `{networkType:0|1|2,password,seed?,restoreHeight?,language?}` |
| Primary address | `getAddress`, `0,0` |
| Seed | `getSeed` |
| Balance | `getBalance` → exact atomic string |
| Create account | `createAccount`, label → plain model JSON |
| Create subaddress | `createSubaddress`, accountIndex,label |
| Export | `getData` → `[Uint8Array keys, Uint8Array cache]` |
| Open exported | `openWalletData`, `'',password,networkType,keysData,cacheData,undefined` |
| Daemon | `setDaemonConnection`, `{uri,rejectUnauthorized:true},false` |
| Daemon height / trust | `getDaemonHeight` / `isDaemonTrusted` |
| Restore / scanned height | `getRestoreHeight` / `getHeight` |
| Close | `close`, `false` |

Random creation rejects `restoreHeight`; restoration rejects `language` alongside a seed. `proxyToWorker:false` is appropriate **inside this dedicated worker**, not on the page. `getData` is the actual library method name; `exportWalletData` is the experiment adapter's descriptive alias.

For production, use a static allowlisted worker protocol wrapper, strict network controls, durable encrypted vault persistence, cross-tab exclusion, mutation serialization and unknown-relay recovery. Terminating the worker is a lock, not a way to cancel/retry an uncertain relay. `adapter.js` is only a minimal transport proof; it intentionally does not implement those full product safeguards.

## Actual public-node browser networking proof

The optional network test explicitly contacts a fixed allowlisted public daemon. It creates a separate **zero-balance mainnet wallet only to read daemon height**, never scans for funds or broadcasts a transaction. The public requests contain no wallet address/seed/keys/password.

```bash
# HTTPS, live public endpoint:
node experiments/wasm-mv3/network-proof.mjs
# Non-CORS HTTP endpoint (unencrypted transport):
node experiments/wasm-mv3/network-proof.mjs http://nodes.hashvault.pro:18081
```

The test appends a tiny static, endpoint-allowlisted native-fetch override to `self.HttpClient.request`; that is the same integration point available to the production worker. `getDaemonHeight()` then runs through real wallet2/Asyncify and this HTTP transport. Return shape required by the WASM glue is `{statusCode,statusText,headers,body}`; JSON response body is a **string**, binary RPC responses must be `Uint8Array` (binary sync not exercised here).

Observed results, not uptime guarantees:

- **Cake HTTPS**: `get_info` returned mainnet height 3,766,687. No-host-permission variant succeeded because Cake allows CORS; host-permission response was `basic`. Native WASM `getDaemonHeight()` returned the same height, trust flag was false, balance remained zero.
- **HashVault HTTP**: without host permission fetch failed; with `http://nodes.hashvault.pro/*` it returned HTTP 200, `response.type:'basic'`, and **no Access-Control-Allow-Origin header**. Native WASM daemon-height read also succeeded, trust false, zero balance. This proves dedicated extension workers inherit Chrome host permissions and can access a real non-CORS node without a local bridge. Plain HTTP lacks transport encryption.

Evidence: `network-results.json`, `network-results-hashvault.json`. Browser manifest host matching is host-based; production CSP and code should additionally restrict exact scheme/port/path. HTTPS certificates remain browser-verified. No TLS-bypass or ignore-certificate-errors flags were used.

## Real funded signing/relay proof on a private fakechain

**PASS**: `regtest.mjs` exercises a complete funded cycle using actual wallet2 WASM and the official Monero v0.18.5.1 daemon, with **no public funds, public daemon, faucet, user wallet or wallet-rpc**. The native daemon is an isolated integration-test fixture, not an extension dependency.

```bash
MONEROD_BIN=/path/to/official/monerod node experiments/wasm-mv3/regtest.mjs
```

The default binary path points at the previously checksum-verified official download under `/tmp/monero-extension-engine-check/`. The script creates its own empty config and private temporary chain/browser directories, chooses unused loopback ports, and starts `monerod --regtest --fixed-difficulty 1 --offline --no-zmq --disable-dns-checkpoints --check-updates disabled`. It checks `nettype:fakechain`, `offline:true`, initial height 1, and restricts browser/worker HTTP to that exact loopback origin. `--no-sync` must **not** be added: it prevents regtest block generation ([upstream issue](https://github.com/monero-project/monero/issues/9124), [reported behavior](https://monero.stackexchange.com/questions/14191/monero-regtest-generateblocks-returns-status-busy)); `--offline` already prevents peer connections.

The actual test:

1. Creates **two fresh full wallets in browser workers** with `{networkType:0,regtest:true}`; no native wallet process. Sets restore height 0 and daemon trust false.
2. Generates 100 private blocks paying the sender. Actual WASM binary-block sync finds balance `3518101685576566` and unlocked balance `1442502852058827` atomic units at height 101.
3. Uses `createTxs` with exact amount `1000000000000` (1 **fake** XMR), `relay:false`, `canSplit:false`. Actual wallet2 creates a signed transaction with real nonzero fee (`2599200000` atomic units in the recorded run), full transaction hex and opaque metadata.
4. Verifies the real daemon's mempool is still empty after preparation.
5. Calls `relayTxs` using that metadata, verifies the returned hash matches the prepared hash and the real daemon accepts it into its mempool. That includes actual transaction/signature validation, not a mock acknowledgment.
6. Generates 12 confirmation blocks, syncs the recipient and verifies both balance and unlocked balance equal exactly `1000000000000`, with the same transaction hash, `isConfirmed:true` and 12 confirmations.
7. Closes/terminates wallet workers, closes Chromium, stops/waits for the daemon, and deletes the temporary chain/browser directories. A four-minute total deadline and signal cleanup bound the test.

Two independent successful runs took ~20–23 seconds (latest: 23.2 seconds). Browser public-network requests: **0**. No seed/password/private key/signed metadata or full transaction hex is logged. Evidence: **`regtest-results.json`**; source: **`regtest.mjs`**. Values and hashes change between independent runs because wallets are genuinely random.

Actual native daemon paths observed (these aliases matter to production allowlists):

```text
/json_rpc
/getblocks.bin
/get_output_distribution.bin
/get_outs.bin
/sendrawtransaction
/get_transaction_pool_hashes.bin
```

Binary request bodies and responses must remain `Uint8Array`; JSON response bodies must remain strings. Do not ship `dist-regtest/` or its loopback host permission in the production extension. The regtest transport is intentionally a test-only local adapter, not the production network policy.

## Production worker hooks: real funded flow and unknown relay outcome

**PASS**: `production-regtest.mjs` tests the application's actual `src/runtime/worker-hooks.ts`, built by **`scripts/build-monero.mjs` into an experiment-only output directory**. The production `dist/`, `public/`, catalog and source are not modified.

```bash
MONEROD_BIN=/path/to/official/monerod node experiments/wasm-mv3/production-regtest.mjs
```

The two test-only shims are appended **after** the real production worker:

- force `regtest:true` when creating disposable wallets;
- map the canonical `http://nodes.hashvault.pro:18081` to the isolated loopback daemon **below the production `HttpClient.request` and `boundedFetch`** by wrapping native `fetch`.

Thus production node validation, bounded reads, timeout/error translation, snapshots, signing and draft/relay logic all execute unchanged. Only the physical HTTP destination and fakechain mode are fixtures. The test manifest permits only the temporary numeric-loopback endpoint. No public HTTP request is made, and no balance, transaction, wallet or daemon response is mocked.

The measured run (~25.6 seconds) proved:

1. `extInit`, `extNetwork('hashvault-mainnet')` and `extConfigureNode` work with the real WASM engine.
2. After 100 private mined blocks, `extSnapshot(0)` returns the exact actual balances, correct network/scanned height and **100 real coinbase history entries**, with atomic amounts represented as strings and no `historyError`.
3. `extPrepare({accountIndex:0,address,amount:'1000000000000',priority:0})` returns a five-minute signed draft with actual fee, **no metadata/full hex exposed**, and no mempool entry before confirmation.
4. `extConfirm` relays exactly once; a second confirmation of that draft rejects with **`DRAFT_NOT_FOUND`**. After 12 blocks, the recipient's production snapshot shows exact balance/unlocked balance `1000000000000` and the confirmed incoming transaction.
5. A second draft sends `500000000000`. The test allows the actual daemon to **accept and validate the signed relay**, fully consumes its successful response, then deliberately throws from native fetch to simulate response loss. Production `extConfirm` reports **`RELAY_UNCERTAIN`**. A second confirmation reports **`DRAFT_NOT_FOUND`**. The counted number of `/sendrawtransaction` calls for this attempt is **exactly 1**: neither the production wrapper nor the underlying native wallet retried it.
6. After another 12 blocks, the recipient's production snapshot shows **both** incoming transfers, matching hashes, confirmed states and exact total/unlocked balance **`1500000000000`**. The unknown outcome was therefore a real accepted payment, not a fabricated failure scenario.
7. Browser, workers, daemon and private chain/profile directories are cleaned up; public requests remain zero.

Evidence: **`production-regtest-results.json`**. The exact pre-fixture production worker SHA256 in that run was `5bb3a1c0d74985d88d23a60eca4112e0468702191dd9c11bd7b8a050090e4cd2`; rerun after production hook changes. The minimal experiment transport was corrected to preserve the vendor's **object-shaped** serialized errors and their `.code`, rather than assuming a JSON string.

This is specifically a production-**worker** integration test. It does not exercise the React send dialog, encrypted vault durability or the main service's persistent unknown-outcome marker. Those need separate acceptance tests. Do not ship `dist-production-regtest/` or its test fixture/loopback manifest in production.

## Not proven

No **public-network funded transfer**, reorg handling, large-wallet performance, vault security, service-worker-lifetime persistence or independent cryptographic/security audit is claimed. The private fakechain proves actual WASM receive/sync/sign/relay/confirmation behavior, not mainnet economics, public-node honesty or complete production safety. Network availability can change. Those remain separate production acceptance tasks; the compatibility and public-node proofs establish that the real bundled WASM wallet engine requires **no local backend**.
