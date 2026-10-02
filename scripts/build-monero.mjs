import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build, transform } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function buildMonero(outDir = 'dist') {
  const info = JSON.parse(await readFile('node_modules/monero-ts/package.json', 'utf8'));
  if (info.version !== '0.11.15') throw new Error('Review the WASM worker before changing monero-ts version.');
  const raw = await readFile('node_modules/monero-ts/dist/monero.worker.js', 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  if (hash !== '14b9223b62d285d13f758d0e7fa88891f9492ea8e29beb7d1093f33b00c5822c') throw new Error('The pinned upstream Monero worker changed. Re-audit it before building.');
  let patched = raw;
  for (const [before, after] of [
    ['new Function("try {return this===window;}catch(e){return false;}")()', '(typeof window === "object" && globalThis === window)'],
    ['new Function("try {return window.navigator.userAgent.includes(\'jsdom\');}catch(e){return false;}")()', '(typeof window === "object" && typeof navigator === "object" && navigator.userAgent.includes("jsdom"))'],
    ['new Function("return this")()', 'globalThis'],
  ]) {
    if (patched.split(before).length !== 2) throw new Error('Unexpected CSP compatibility patch structure.');
    patched = patched.replace(before, after);
  }
  patched = (await transform(patched, { loader: 'js', minify: false, legalComments: 'inline' })).code;
  const uuid = /static getUUID\(\) \{\s*return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"\.replace\(\/\[xy\]\/g, \(function\(\w+\) \{[\s\S]*?\}\)\);\s*\}/g;
  if ([...patched.matchAll(uuid)].length !== 1) throw new Error('Unexpected upstream UUID implementation.');
  patched = patched.replace(uuid, 'static getUUID() { return globalThis.crypto.randomUUID(); }');
  if (/\b(?:new\s+Function\s*\(|eval\s*\()/.test(patched)) throw new Error('Runtime JavaScript compilation is not permitted.');
  const hooks = await build({ entryPoints: ['src/runtime/worker-hooks.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', write: false, minify: true });
  const vendor = (await transform(patched, { loader: 'js', minify: true, legalComments: 'inline', target: 'chrome120' })).code;
  await mkdir(outDir, { recursive: true });
  // Upstream wallet logs are intentionally disabled: errors cross the typed protocol,
  // never developer-console logs that may contain private wallet/native request data.
  await writeFile(`${outDir}/monero.worker.js`, `/* Pinned monero-ts 0.11.15; bundled WASM; no remote code. */\nconsole.log=console.warn=console.error=()=>{};\n${vendor}\n${hooks.outputFiles[0].text}`);
  await copyFile('node_modules/monero-ts/dist/monero.worker.js.LICENSE.txt', `${outDir}/monero.worker.js.LICENSE.txt`);
  await copyFile('node_modules/monero-ts/LICENSE.txt', `${outDir}/MONERO-TS-LICENSE.txt`);
  await writeFile(`${outDir}/monero-engine-provenance.json`, JSON.stringify({ library: 'monero-ts', version: info.version, originalWorkerSha256: hash,
    source: 'https://github.com/woodser/monero-ts', wasm: 'embedded in local worker; no remote downloads',
    compatibilityPatches: ['static browser detection (two)', 'globalThis instead of legacy dynamic fallback', 'CSPRNG UUID'],
    applicationHooks: ['fixed-node credential-free bounded fetch', 'untrusted daemon only', 'exact local snapshots', 'one-shot signed transaction drafts'] }, null, 2));
  console.log(`Bundled actual Monero WASM wallet: ${outDir}/monero.worker.js`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildMonero(process.argv.includes('--dev') ? 'public' : 'dist');
