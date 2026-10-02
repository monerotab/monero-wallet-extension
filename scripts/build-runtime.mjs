import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Run after Vite has copied public/. Neither entry is a second web server. */
export async function buildRuntime(outDir = 'dist') {
  await mkdir(outDir, { recursive: true });
  await build({ entryPoints: { offscreen: 'src/runtime/offscreen.ts', launcher: 'src/runtime/transport-background.ts' },
    outdir: outDir, entryNames: '[name]', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
    minify: true, sourcemap: false, legalComments: 'none' });
  await copyFile('public/offscreen.html', path.join(outDir, 'offscreen.html'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRuntime(process.argv[2] ?? 'dist');
