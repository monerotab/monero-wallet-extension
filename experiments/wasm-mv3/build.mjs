import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build, transform } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const packageRoot = path.join(root, 'node_modules/monero-ts');
const info = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (info.version !== '0.11.15') throw new Error('Audit CSP patches before changing monero-ts version');
const raw = await readFile(path.join(packageRoot, 'dist/monero.worker.js'), 'utf8');
const sourceHash = createHash('sha256').update(raw).digest('hex');
if (sourceHash !== '14b9223b62d285d13f758d0e7fa88891f9492ea8e29beb7d1093f33b00c5822c') throw new Error('Pinned worker changed: audit vendor and update patch hash');
let patched = raw;
const patches = [
  ['new Function("try {return this===window;}catch(e){return false;}")()', '(typeof window === "object" && globalThis === window)'],
  ['new Function("try {return window.navigator.userAgent.includes(\'jsdom\');}catch(e){return false;}")()', '(typeof window === "object" && typeof navigator === "object" && navigator.userAgent.includes("jsdom"))'],
  ['new Function("return this")()', 'globalThis'],
];
for (const [before, after] of patches) {
  if (patched.split(before).length !== 2) throw new Error('CSP patch occurrence mismatch: ' + before);
  patched = patched.replace(before, after);
}
// Format for a small, pinned-structure replacement of the library's non-secret UUID helper.
patched = (await transform(patched, { loader: 'js', minify: false, legalComments: 'inline' })).code;
const uuidBefore = /static getUUID\(\) \{\s*return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"\.replace\(\/\[xy\]\/g, \(function\(\w+\) \{[\s\S]*?\}\)\);\s*\}/g;
if ([...patched.matchAll(uuidBefore)].length !== 1) throw new Error('UUID patch occurrence mismatch');
patched = patched.replace(uuidBefore, 'static getUUID() { return globalThis.crypto.randomUUID(); }');
if (/\b(?:new\s+Function\s*\(|eval\s*\()/.test(patched)) throw new Error('Dynamic JavaScript remains');

for (const [name, source] of [['dist', patched], ['dist-original', raw]]) {
  const out = path.join(here, name);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'monero.worker.js'), source);
  await copyFile(path.join(packageRoot, 'dist/monero.worker.js.LICENSE.txt'), path.join(out, 'monero.worker.js.LICENSE.txt'));
  await copyFile(path.join(packageRoot, 'LICENSE.txt'), path.join(out, 'MONERO-TS-LICENSE.txt'));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: `Monero real WASM CSP proof ${name}`, version: '0.0.1',
    description: 'Offline disposable wallet compatibility proof, not a production wallet.',
    background: { service_worker: 'background.js' },
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'none';" },
    action: { default_title: 'Offline WASM proof' },
  }, null, 2));
  await writeFile(path.join(out, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
  await writeFile(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Monero WASM compatibility proof</title></head><body><h1>Monero WASM compatibility proof</h1><pre id="status">Starting offline wallet proof…</pre><script src="proof.js"></script></body></html>');
  await build({ entryPoints: [path.join(here, 'proof.js')], outfile: path.join(out, 'proof.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', sourcemap: false });
}
await writeFile(path.join(here, 'build-report.json'), JSON.stringify({ moneroTsVersion: info.version, originalWorkerSha256: sourceHash, patches: ['static browser detection x2', 'static globalThis fallback', 'crypto.randomUUID helper'], embeddedWasm: true }, null, 2));
console.log('Built original and patched MV3 PoCs; source worker SHA256:', sourceHash);
