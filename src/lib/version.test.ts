import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from './version.ts';

it('uses one release version everywhere', () => {
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).version, APP_VERSION);
  assert.equal(JSON.parse(readFileSync('public/manifest.json', 'utf8')).version, APP_VERSION);
});
