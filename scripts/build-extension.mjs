import sharp from 'sharp';
import { buildMonero } from './build-monero.mjs';
import { buildRuntime } from './build-runtime.mjs';
await buildMonero('dist');
await buildRuntime('dist');
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) await sharp('public/monero.svg').resize(size, size).png().toFile(`dist/icons/${size}.png`);
let notices = 'Monero Wallet Standalone — third-party notices\n\nIndependent project; not affiliated with or endorsed by the Monero Project.\n';
for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react', 'qrcode.react', '@fontsource/roboto', 'motion', 'framer-motion', 'motion-dom', 'motion-utils', 'zod']) {
  const license = ['motion', 'framer-motion', 'motion-dom', 'motion-utils'].includes(name) ? 'LICENSE.md' : 'LICENSE';
  notices += `\n\n=== ${name} ===\n\n${await readFile(`node_modules/${name}/${license}`, 'utf8')}`;
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices);
await writeFile('dist/LICENSE.txt', await readFile('LICENSE', 'utf8'));
console.log('Chrome MV3 extension ready: dist/');
