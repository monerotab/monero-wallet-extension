import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version || manifest.version !== '2.3.0' || manifest.action.default_popup !== 'index.html?popup=1' || !manifest.permissions.includes('offscreen') ||
  manifest.host_permissions.some(value => /localhost|127\.0\.0\.1|<all_urls>/.test(value))) throw new Error('Build the standalone 2.3 popup extension first.');
if (typeof manifest.description !== 'string' || manifest.description.length > 132 || manifest.name.length > 75) throw new Error('Chrome Web Store limits: description ≤ 132 and name ≤ 75 characters.');
for (const file of ['monero.worker.js', 'onboarding.html', 'offscreen.html', 'offscreen.js', 'launcher.js']) await readFile(`dist/${file}`);
await mkdir('release', { recursive: true });
async function zip(name, setup) {
  const output = createWriteStream(`release/${name}`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); archive.on('warning', reject); });
  archive.pipe(output); setup(archive); await archive.finalize(); await done;
  console.log(`release/${name} (${archive.pointer()} bytes)`);
}
await zip('monero-wallet-extension.zip', archive => {
  archive.directory('dist', false);
  archive.file('README.md', { name: 'README.md' });
  archive.file('SECURITY.md', { name: 'SECURITY.md' });
  archive.file('artifacts/popup-send.png', { name: 'artifacts/popup-send.png' });
});
await zip('monero-wallet-source.zip', archive => {
  for (const directory of ['src', 'scripts', 'tests', 'shared']) archive.directory(directory, directory);
  archive.glob('**/*', { cwd: 'public', ignore: ['monero.worker.js', 'monero.worker.js.LICENSE.txt', 'MONERO-TS-LICENSE.txt', 'monero-engine-provenance.json'] }, { prefix: 'public' });
  for (const file of ['popup-send.png', 'popup-receive.png', 'popup-locked.png', 'popup-settings.png', 'popup-onboarding.png']) archive.file(`artifacts/${file}`, { name: `artifacts/${file}` });
  for (const file of ['build.mjs', 'adapter.js', 'proof.js', 'test.mjs', 'network-proof.mjs', 'regtest.mjs', 'production-regtest.mjs',
    'README.md', 'test-results.json', 'network-results.json', 'network-results-hashvault.json', 'regtest-results.json', 'production-regtest-results.json']) {
    archive.file(`experiments/wasm-mv3/${file}`, { name: `experiments/wasm-mv3/${file}` });
  }
  for (const file of ['package.json', 'package-lock.json', 'index.html', 'onboarding.html', 'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', '.gitignore', 'README.md', 'SECURITY.md', 'TESTING.md', 'LICENSE']) archive.file(file, { name: file });
});
