# Testing the standalone popup build 2.3.0

## Summary of completed checks

| Command / check | Result |
| --- | --- |
| Clean `npm ci --include=dev` | PASS, installed from the lockfile |
| `npm run build` | PASS, TypeScript + Vite + bundled Monero WASM |
| `npm test` | **147/147 PASS** |
| `npm run test:ui` | **6/6 PASS**, real Chromium MV3 |
| `npm run test:engine` | **PASS**, real WASM with no network or local server |
| `MONEROD_BIN=… npm run test:regtest` | **PASS**, real signing, relay and confirmations on a private fakechain |
| `npm audit --include=dev` | **0** known vulnerabilities in the dependency graph at the time of the check |

None of the 2.x checks require `monero-wallet-rpc`. The native `monerod` is started **only by the optional regtest script**, with a temporary fakechain, not as a component of the extension.

## Unit and integration tests

- **15**: exact XMR/uint64 values, 12 decimal places, invalid amounts, payment URIs, CSV/formula injection.
- **16**: real WebCrypto AES-256-GCM/PBKDF2 and IndexedDB semantics through fake-indexeddb. Covered: KDF/nonce, fresh salt and IV, authenticated metadata, wrong password, modified ciphertext, import/export, password change, CAS conflicts, abort after put, session close during encryption and safe errors.
- **20**: the orchestration service with the real vault and an **explicitly test-only** native-engine double. Covered: refusal to save or export after a mutation, consistency of the native and AES passwords, Web Lock retention, ownership transfers, worker crash, a durable marker before relay, unknown outcome/one-shot, no clearing during a send, stale-dialog and cross-tab races, and keeping the lock when storage hangs.
- **10**: network allowlist, no credentials/referrer/cache, redirects refused, sizes and timeouts, cancelling an unread body on an early HTTP error, safe errors and the network check in `get_info`.

- **22**: direct UI ↔ offscreen transport, strict URL and frame allowlists, unique request IDs, large messages with acknowledged chunks, a disappearing client without repeating operations, cancelling only unconfirmed drafts, auto-lock and the marker coordinator.
- **5**: explicit identity of the wallet shown by the UI, a check at dequeue, no seed/address/prepare/close for a replaced wallet, marker-before-broadcast and keeping an unknown relay when the popup closes. Clearing the recovery marker requested DURING a relay is refused immediately, not after the relay finishes.
- **4**: storage callback races and offscreen document lifetime. An old clear cannot overtake the write of a new hash; a storage operation already issued holds the queue until it settles; a stale document ID is refused; a new coordinator VM restores the current identity.

Test doubles are not used in production and are not presented as proof of the native cryptography. The coordinator races model a controlled order of async callbacks; they do not prove crash durability of Chrome or the OS. The cryptography is verified separately below.

## Browser scenarios with the real product

`tests/standalone.spec.ts` loads the **built `dist/`** into a separate temporary Chromium profile. There is no Vite server, companion, wallet-rpc or fake wallet engine.

1. The real toolbar popup is opened with `chrome.action.openPopup`; the runtime context and CDP confirm **800 × 600** with no horizontal overflow. Covered: light and dark themes, focus trap/inert, keyboard, the three routes of the separate onboarding, and widths 390/800/1280. The manifest has no localhost/all-URLs host permissions and no JS `unsafe-eval`.
2. The real WASM creates a stagenet wallet: seed25 and a check of random words, account/rename/subaddress/QR/URI. The popup closes and reopens with the same selected account, the real address and balance. CDP stops and restarts the service worker: a fresh JS realm, the same offscreen session. Destroying the offscreen document, in contrast, locks the wallet; the password restores the saved data. The offline history is empty without an error and shows the honest limitation for pending incoming payments. rAF measurements confirm the intermediate opacity/translation of the real animation, then the final state; reduced motion is checked separately.
3. Only the explicit node-health `get_info` is stubbed, **not** the wallet. CDP intercepts the offscreen fetch itself. Covered: consent, exactly two allowed health requests, the node's network, encrypted node persistence, and no network on reopening or ordinary polling.
4. Real change of the inner and outer password, encrypted export, rejection of the old password, seed restore with the same address and import of the backup into a clean profile.
5. A shared session between UIs, onboarding refusing to switch the active wallet implicitly, the seed hidden on leaving. A real SW storage race: the dialog for an old hash does not remove the new one; confirming the current hash clears the durable marker. This check found that Chrome's offscreen document does not pass `sender.documentId`; the final bootstrap/actor fence was verified in real Chrome.
6. Address labels, the encrypted address book, send validation and offline message signing and verification with the real engine.

Ordinary network access is blocked both on the pages and in the offscreen document through CDP, and DNS is blocked as well. Only the `get_info` fixture gets a response. Temporary profiles are deleted. No user wallets or funds are used. Seeds are not written to screenshots or logs; traces and automatic failure screenshots are turned off.

## Strict-CSP proof of the real WASM

`experiments/wasm-mv3/test.mjs` compares the original and a minimally patched worker:

- The original vendor worker is **rejected by the CSP, as expected**, because of `new Function`.
- The patched one works with `script-src 'self' 'wasm-unsafe-eval'` and **`connect-src 'none'`**.
- In three fresh workers: create, address, seed25, balance, accounts/subaddresses, native export, wrong password, reopening and seed restore with the same address.
- **0 HTTP(S) requests, 0 unhandled runtime errors**; the interface keeps its heartbeat; COOP/COEP is not required.
- The native restore height of a new wallet is kept; a restore with an explicit `0` stays `0`.

Result: `experiments/wasm-mv3/test-results.json`. The expected CSP rejection of the original worker is a positive part of the test, not a hidden production failure.

## Real public read-only connections

A separate `network-proof.mjs` was checked in a real extension worker:

- **Cake HTTPS**: the real `get_info` and native `getDaemonHeight` matched; the daemon was set as untrusted.
- **HashVault HTTP without Access-Control-Allow-Origin**: without the host permission the fetch is refused; with the permission it gets a real `200/basic`, and then native `getDaemonHeight` succeeds. This verifies that the extension can reach non-CORS nodes directly.

Results: `network-results.json`, `network-results-hashvault.json`. This is a snapshot of availability, not a promise of uptime. Only read-only requests, with no seed, keys or wallet address in the requests and no funds sent.

## Real transfers on a private fakechain

`npm run test:regtest` runs **`experiments/wasm-mv3/production-regtest.mjs`**. It builds the current production worker through `scripts/build-monero.mjs`; it does not fake signing or balances.

The official `monerod 0.18.5.1` is used with `--regtest --offline --fixed-difficulty 1`, loopback-only RPC/P2P, a separate temporary directory, and DNS checkpoints and updates turned off. Before mining, `nettype=fakechain`, `offline=true` and height `1` are verified.

Only a test-only wrapper adds `regtest:true` when creating the native wallet and redirects the canonical HashVault URL to the temporary isolated daemon. The production allowlist, HttpClient and hooks stay unchanged. This wrapper and the loopback manifest are **not included in the installation ZIP**.

Done:

1. 100 fake blocks are mined and the real WASM scans them. `extSnapshot` shows real coinbase balances and 100 transactions as atomic strings.
2. `extPrepare` signs **1 fake XMR** with a real fee; the mempool stays empty and the signed metadata is not revealed in the summary.
3. `extConfirm` sends the transaction **once**; a repeat is refused with `DRAFT_NOT_FOUND`.
4. After 12 blocks the recipient really scans the incoming transaction: balance and unlocked balance **1 000 000 000 000** atomic units, 12 confirmations.
5. A second transfer of **0.5 fake XMR** is really accepted by the daemon, after which the fixture deliberately loses the response. Production returns **`RELAY_UNCERTAIN`** and a repeated confirm is refused; **exactly one** HTTP relay is recorded, with no automatic retry inside the SDK.
6. 12 more blocks: the recipient finds both transfers, with an exact total of **1 500 000 000 000** atomic units.
7. The network gate is closed separately before each snapshot: a real empty wallet, 100 mined records, a **pending outgoing payment before mining** with exact amount and fee, a confirmed incoming payment, the final balance. In every case there are **0 HttpClient attempts and 0 fetches**, not merely intercepted or blocked network access. A successful relay appears as exactly one pending row, and no outgoing payments are lost.
8. Native keys and cache are exported and reopened: balance, history, label and note are kept offline; again 0 RPC. This is a regression test against the SDK's default `getTxs()`, which tried to refresh the incoming pool even when reading the "local" history.

Additional stages in 2.2/2.3 (13 stages in total): send max with the fee deducted (amount + fee equal the unlocked balance exactly), address book add/edit/delete including stale-row errors, message signing and verification, and a transaction-key proof checked with `checkTxKey`.

Result: `experiments/wasm-mv3/production-regtest-results.json`. It contains the hash of the tested production worker, but no seed, passwords, addresses or signing metadata. Final verified worker SHA256 of the original regtest run:

```text
5f1e8b4e60932b7b370bf386b45ad4ea73aa53dc6e7a5531dcc36830ac92b7b1
```

During this scenario: **0 public network requests**; all Chromium and daemon processes and temporary data are cleaned up. Fake XMR **has no value**. An additional early pure-SDK regtest also passed; the production-hooks test is the main proof of the current implementation.

The CLI for the fixture was downloaded from the official source; the SHA256 of the v0.18.5.1 distribution matched the published one (`22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958`). A separate GPG signature check was not done in this session. The binary is not included in the extension or the sources; verify the official signatures for your own checks.

## What these tests do not prove

- No funded-transfer cycle was run **on the public mainnet or stagenet** with real user wallets; the private fakechain is a separate isolated network.
- Not done: a multi-day full-chain restore, large merchant wallet caches, reorg or hostile-node stress, an independent cryptographic audit or an audit of the whole vendored SDK.
- Crash durability is not proven when the SW stops exactly during an unfinished Chrome storage operation or when the OS crashes. Memory fences and deterministic scheduler fixtures do not replace Chrome's atomic transactional storage.
- No stress test of backups near the maximum of 180 million characters, eight simultaneously active UIs, memory exhaustion or all combinations of chunk loss and timeouts.
- `npm audit: 0` refers to the npm dependency graph, **not** to the libraries already built into the prebuilt worker. Overrides do not rebuild vendor code.
- No promise of uptime or honesty of public nodes, no protection against an infected browser or OS, and no guarantee that data survives deleting the profile.
- Having tests does not make a new wallet suitable for large amounts without further review.
