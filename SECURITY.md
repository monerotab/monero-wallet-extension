# Standalone wallet security model — 2.3

Independent software, **not an official Monero product and not independently security-audited**. Start with stagenet; keep a separate offline seed backup. Do not entrust substantial funds solely to a new browser wallet.

## Architecture and trust

The installed extension files, bundled monero-ts/Monero WASM, Chromium, operating system and browser profile are trusted. Public nodes are **untrusted**. There is no local server, wallet-rpc, pairing token, remote key-holding service, native messaging host or remotely loaded executable code.

An extension offscreen document (`WORKERS` reason) owns the WalletService and dedicated WASM worker. Popup, onboarding and optional full-size tab use direct authenticated `chrome.runtime.Port` connections to it. The MV3 service worker only ensures the offscreen document, opens approved pages and coordinates public recovery-marker storage; wallet requests, passwords and seeds do not transit it. There are no content scripts or externally-connectable APIs. Closing a popup does not terminate an already-requested scan or confirmed relay; it never initiates a new payment or automatic sync.

Only exact same-extension, top-frame UI URLs are accepted; the offscreen entry is separately authorized. Requests have unique IDs, bounded in-flight counts and acknowledged bounded chunks for large encrypted backups. A disconnected request is never replayed. Transaction drafts belong to the preparing UI port: disconnect cancels unconfirmed drafts, including a late prepare result, but never interrupts a confirmation already started. Seed results for disconnected clients are discarded.

Every wallet-scoped request carries the explicit vault identity captured by the rendering UI, not an automatically adopted polling identity. A serialized host gate checks it at execution time, shared with wallet switches, idle closure and cleanup. Stale views cannot obtain another wallet's seed/snapshot or prepare/confirm against it; create/open/restore require an explicitly empty session. `status` followed by `snapshot` is bound to the status identity.

Five minutes (or the open wallet's own auto-lock setting: 1, 5, 15, 30 or 60 minutes, never more than one hour) without trusted visible user interaction triggers auto-lock after active operations and explicit synchronization finish. Polling is not activity. This is not a strict five-minute destruction deadline during long work. Explicit Lock stops/saves synchronization; already-started relay is not cancelled. Restarting Chrome, losing the offscreen document, or reloading the extension starts locked; keys are never automatically unlocked from storage.

A Web Lock permits only one unlocked wallet engine per extension origin. All approved UI views share that offscreen session; locked-state metadata reads do not claim ownership. Mutations are serialized, with bounded queue length/wait. Worker failure wipes the active session immediately; physical ownership remains held until an already-started marker/storage critical section settles, preventing stale callbacks from changing another tab's recovery record.

This does not defend against a compromised OS/browser, developer tools, a malicious extension with debugging access, altered distribution files, or an attacker reading an unlocked process. Do not enter a seed supplied by someone else to receive money.

## Actual engine and CSP

- monero-ts **0.11.15**, pinned original worker SHA256 in `scripts/build-monero.mjs`.
- Actual upstream WebAssembly performs key generation, scanning, cryptography and transaction signing. The native RNG requires browser `crypto.getRandomValues`; no weak random fallback is added.
- Four explicit compatibility replacements: two static browser predicates, `globalThis` instead of a legacy dynamic fallback, and `crypto.randomUUID` for internal worker IDs.
- CSP allows local scripts and **`wasm-unsafe-eval`**, not JavaScript `unsafe-eval`. The build rejects remaining dynamic JavaScript compilation. WASM is embedded in the packaged worker; no CDN downloads, SharedArrayBuffer/COOP requirement or remote source execution.
- Worker logs are disabled. Main-thread errors are reduced to safe fixed messages/codes, not raw native stacks, passwords or request bodies.
- Pinned prebuilt SDK code remains an upstream supply-chain dependency. **npm overrides/audit do not rebuild or audit dependencies already embedded in its vendor bundle.** Passing npm audit is not a security audit of Monero WASM or this application.

## Encrypted browser vault

`src/runtime/vault.ts` uses IndexedDB and native WebCrypto:

- AES-256-GCM, 128-bit authentication tag; fresh random **16-byte salt + 12-byte IV on every save**.
- PBKDF2-HMAC-SHA256, **600,000 iterations**. Choose a long, unique password; this KDF does not make a weak password safe against offline guessing.
- Native keys/cache and selected node/settings are encrypted together. Public metadata (ID, user-chosen name, network, timestamps, schema and revision) is visible but authenticated with the ciphertext through AAD.
- No addresses, balances, recovery phrase, plaintext native wallet files or password are persisted outside this encrypted payload.
- In-memory opaque vault sessions hold a non-extractable PBKDF2 key, not persistent password text. AES keys are non-extractable. Native WASM necessarily retains unlocked key material/password state in its own memory until its worker is terminated.
- Atomic IndexedDB revision/authenticated-stamp comparison prevents stale writers from overwriting newer state. Conflicts fail closed, not by blind retry.
- Password rotation changes native and outer encryption together. Any uncertain change/export/commit failure destroys the session and keeps the last committed vault usable; it cannot subsequently save mismatched inner/outer passwords.
- Imported backups receive structural validation first; authentication and native payload/network checks occur on unlock. Import never overwrites an existing ID/name. Metadata shown before unlock is not yet authenticated.
- Limits: 128 MiB encrypted plaintext payload, bounded settings/schema/KDF parameters and backup size. A wallet exceeding the cap needs another compatible tool or seed recovery. Exported backups retain their old passwords after rotation.
- Buffers owned by the application are wiped best-effort after import/export use. JavaScript strings and garbage-collected copies cannot be securely zeroized. Disk snapshots, swap and browser/OS compromise are outside this guarantee.

Uninstalling, clearing the extension origin, profile loss or storage failure can destroy data. `unlimitedStorage` reduces quota/eviction problems; it is not a backup. Preserve the recovery phrase offline and a private encrypted export.

## Direct node networking (public and custom nodes)

- Bundled nodes: a fixed, source-controlled catalog in `shared/nodes.json`, with no remote catalog. **Custom nodes** (such as your own `monerod`) are added per wallet:
  - Address format: `http(s)://host[:port]`, where the host is a DNS name, an IPv4 address or a bracketed IPv6 address. `http://127.0.0.1:18081` and `http://localhost:18081` are allowed.
  - Rejected: credentials, paths, query strings, fragments and other schemes. The address is normalized to its origin. Duplicates of a bundled or saved origin are refused, with at most 16 custom nodes per wallet.
  - The list is stored **encrypted inside that wallet's vault settings**, never in global/plain storage. Locked views and other wallets never list it.
  - Adding a node never contacts it. Removing the selected node clears the selection and invalidates drafts.
  - No proxies, RPC login, insecure TLS flags or trusted daemon mode.
- **Code allowlists are the network boundary.** The service passes only the checked/selected node's exact origin to `boundedFetch` and to the worker. The worker re-validates it and admits no other origin (other ports on the same host are refused), and a bundled node id can never be redirected. Redirects are rejected; fetch omits credentials/referrers and bypasses caches. Browser TLS verification applies to HTTPS.
- **Trade-off:** mandatory `host_permissions` still name only the public catalog hosts. `optional_host_permissions` (`http://*/*`, `https://*/*`) lets the UI request **one exact origin** with `chrome.permissions.request` on a user gesture. CSP `connect-src` is `'self' http: https:`, because CSP cannot list user-chosen origins in advance, so CSP no longer pins catalog origins. Script sources remain local-only (`script-src 'self' 'wasm-unsafe-eval'`); remote code still cannot load.
- Creation, opening, listing nodes, reading balances/history/status and ordinary view polling are local. Network access is enabled only around explicit checks, node selection, sync, prepare and confirm, then revoked.
- `node.check` sends only a fixed `get_info`: 8 seconds, 256 KiB. Native wallet requests have 30-second per-request and 32 MiB response bounds. Early errors abort discarded response bodies as well as normal timeouts. There is no automatic payment retry and no automatic fallback to another node.
- Network selection checks the vault's native network, the node's registration (catalog or this wallet's list) and the node response. The saved endpoint is always configured **untrusted**, including loopback nodes that wallet2 would otherwise auto-trust. A node can lie about its network/height, censor requests or harm privacy; HTTPS authenticates transport, not the correctness of blockchain data.
- Browser fetch does **not** provide application-level DNS/IP pinning. This is not a claim of DNS-rebinding protection against a compromised allowlisted operator/domain. A custom node is only as trustworthy as the host name and network path you choose.
- Connection failures to a custom node, including Chrome's opaque CORS/permission errors, are reported as `NODE_UNREACHABLE`. The message tells the user to allow access when prompted and to check `monerod` flags: `--restricted-rpc`, and for remote access `--rpc-bind-ip 0.0.0.0 --confirm-external-bind`.
- Public nodes observe IP, request timing and query patterns. HTTP exposes/modifies traffic to network observers. No integrated Tor/proxy is provided; there is no privacy guarantee from using a public node.
- Permission inheritance for dedicated extension workers was verified against a real non-CORS node. This privilege does not apply to an ordinary web development preview.

## Transaction and recovery safety

Amounts/fees/balances are exact atomic-unit strings/BigInt, never floating-point financial arithmetic.

Preparation validates the actual network/address and fresh sync, signs with `relay:false`, verifies the native destination/amount/fee/available funds and returns only a review summary. Opaque signed metadata stays **only in worker memory**. Drafts are wallet/generation/height-bound, expire after five minutes and are one-shot. Node changes, sync, close and relay invalidate drafts; unsupported unsigned/multisig results fail closed.

Sending requires a completed sync no older than two minutes. This is synchronization with the chosen node, not independent full-node consensus validation. The user separately confirms the full address, amount, fee and tx ID. Confirmation consumes the draft before relay checks; even unsuccessful attempts cannot automatically retry it.

**Before native broadcast**, the serialized service persists only `{txHash, createdAt}` in `chrome.storage.local` through the coordinator. Only the current offscreen document may request a write. Because Chromium can omit `sender.documentId` for offscreen messages, the document captures its browser-issued identity once through an offscreen-only bootstrap request and attaches that immutable actor ID to later marker requests. The coordinator compares it to the browser's current offscreen context at dequeue and immediately before mutation after awaited setup; native sender ID must also match when provided. The actor is never refreshed by a stale callback. All marker reads/writes are serialized until actual storage settlement, so an old offscreen callback cannot overtake a replacement's new marker. This public identifier is privacy-sensitive but contains no signing metadata, destination, amount or keys. A service-confirmed successful relay plus successful encrypted save clears it; response loss, uncertain outcome, tab teardown or failed storage keeps the warning. No blind resend is performed. The real production worker was tested with an accepted relay whose response was deliberately lost: exactly one HTTP relay attempt and `RELAY_UNCERTAIN`.

Manual resolution carries the **specific hash captured when the confirmation dialog opened**. It compares current state under the wallet Web Lock; a locked tab must acquire temporary exclusive ownership. An active broadcast cannot be cleared, and a stale dialog cannot erase a newer transfer's hash. This is a recovery guard, **not proof** that the user checked the chain. Never dismiss it merely to retry a payment.

Once a transaction reaches a node, closing or locking cannot undo it. Restore/sync and inspect the recorded ID before deciding what happened.

## UI privacy and operational limits

- Seed reveal requires a separate acknowledgement; hidden on tab leave, dialog close, wallet change and after 60 seconds. Late async responses after hiding do not reveal it again.
- Downloaded backups, QR images, CSV and clipboard content are outside application control. CSV cells are escaped against formula injection. Never publish wallet exports or passwords.
- No telemetry, external fonts, exchange-rate requests, content scripts or externally-connectable wallet API.
- Full synchronization can be lengthy and download substantial block data. It continues inside the offscreen document when a popup closes. Lock aborts active scan networking and saves partial progress; offscreen/browser loss can require rescanning since the last saved checkpoint.
- Theme, last page, hidden-balance preference and selected `{vaultId, accountIndex}` are non-secret UI preferences in localStorage. Addresses, balances, payment forms and secrets are not stored there.
- Fresh wallets keep the native conservative creation/restore height; first connection does not silently advance it to current tip. Restoring with an excessive height can miss funds; choose zero when unknown.
- History is obtained without network access: confirmed native transactions plus cached outgoing transfers, preserving pending/failed outgoing and full confirmed transaction context during deduplication. Incoming pool-only transactions are not queried by ordinary polling; the UI explicitly says incoming payments appear after mining and synchronization. This avoids the SDK default `getTxs()` silently trying to refresh the remote pool. UI “Load more” is client-side, not true database pagination. Extremely large wallet histories remain memory/storage-limited. Genuine history failures are reported separately, never converted to a fake empty history.
- No hardware wallets, multisig, Polyseed, OpenAlias, cold signing or sweep-all.
- Private fakechain testing is not a funded public mainnet/stagenet test, a reorg stress test or a formal audit. See `TESTING.md`.

Report security issues privately to the build maintainer. Never attach real recovery phrases, passwords, keys, signed metadata or wallet backups to public bug reports.

## Additions in 2.2

- New wallet-scoped actions (identity-gated like every other wallet mutation, never neutral):
  - `address.label`, `contact.add/edit/delete`, `message.sign/verify`, `tx.key`.
  - Mutations persist the encrypted vault.
  - Contact edits and deletes carry the expected address and fail closed if the row changed (`STALE_CONTACT`).
- "Max" uses wallet2 `subtract_fee_from_outputs` in a single non-split transaction.
  - The review shows what the recipient receives and the deducted fee.
  - The worker verifies `destination + fee == requested amount` before a draft can be confirmed.
- Offline address checks in the UI (base58 + Keccak-256 checksum + network prefix) are only feedback. The engine validates again before signing or saving.
- `monero:` links are parsed locally; separate payment IDs are rejected.
- Signing, verification and transaction keys never contact a node.

## Wallet management (2.3)

All actions below are wallet-scoped: identity-gated like every other mutation, never neutral, open, poll or read-only.

- **Password gates.** The service checks a re-entered password against the open wallet's own encrypted vault record: the same PBKDF2 (600 000 iterations) + AES-GCM decryption as unlocking. Nothing is written. The decrypted bytes are zeroed at once. The password is never stored, logged or passed to the worker for this check. A wrong password is `WRONG_PASSWORD` and changes nothing; a missing one is `PASSWORD_REQUIRED`. A password that is supplied is always verified, even where it is optional.
  - Recovery phrase (`wallet.seed`) needs the password. The only exception is the backup step right after `wallet.create`: in the same offscreen session, for at most 30 minutes, and only until the wallet is first locked. Closing, auto-lock, deletion, a failure and a password change all end this window. Restored, imported or reopened wallets never get it.
  - `wallet.keys` needs the password. It returns the primary address, the public view and spend keys and the private **view** key. The private spend key is never returned to the UI.
  - `wallet.password` verifies the current password first. A wrong one leaves the wallet open and unchanged.
  - Optional per-wallet setting "confirm payments with password" (`wallet.settings`): if on, `tx.confirm` verifies the password before the recovery marker is written or anything is relayed. Failures consume the review; nothing was sent. Turning the setting off needs the password.
- **Settings** (`autoLockMinutes`, `confirmWithPassword`) live in the encrypted vault settings, next to the wallet's custom nodes. The host reads the auto-lock limit only from service status. Polls still never count as activity, active work still finishes first, and the limit is capped at one hour.
- **Rename** changes the authenticated vault name in the same compare-and-swap revision as the data. A name used by another wallet aborts the whole IndexedDB transaction (`DUPLICATE_NAME`), and the wallet stays open.
- **Delete** (`wallet.delete`) requires the password. It is refused during sync or relay (`SYNC_BUSY`) and while a transfer outcome is unresolved (`PENDING_TRANSFER`). It then destroys the worker **without saving**, deletes the encrypted record only if it is still exactly the revision this session committed, and releases the wallet lock. Like Lock, it leaves no wallet identity. Exported backups are not affected: they remain valid and are the user's responsibility.
- **Rescan** (`wallet.rescan`) is an explicit network operation on the selected node, inside the same network gate as sync. Lock cancels it. It runs wallet2's soft rescan: keys, accounts, subaddresses, labels, address book, notes and sent-transaction keys are kept; outputs, balances and history are rebuilt from the chain. The recipients recorded for earlier outgoing payments are lost. It is refused while a payment is unconfirmed (`PENDING_OUTGOING`) or a transfer outcome is unresolved, and for a height above the node's height. The new restore height is saved in the encrypted vault. A malicious node can hide outputs during a rescan exactly as during a sync.
- **Integrated addresses** (`address.integrated`) are built locally on the primary address. A missing payment ID is 8 random bytes from the browser CSPRNG (never all zeros). The worker decodes the result again and checks it against the primary address and payment ID before returning it. Short payment IDs are visible on-chain to the recipient only, but they link the payments that reuse them.
