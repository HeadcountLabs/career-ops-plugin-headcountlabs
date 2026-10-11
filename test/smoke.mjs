// Zero-network smoke test: the entry imports cleanly and exposes only valid
// hooks that match the manifest. Run by `plugins.mjs add` and the registry CI.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = ['provider', 'ingest', 'search', 'notify', 'export'];

const manifest = JSON.parse(readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));
const mod = await import(pathToFileURL(path.join(here, '..', manifest.entry || 'index.mjs')).href);
const hooks = mod.default;

assert(hooks && typeof hooks === 'object', 'default export must be an object of hooks');
const keys = Object.keys(hooks);
assert(keys.length > 0, 'declare at least one hook');
for (const k of keys) assert(KINDS.includes(k), `unknown hook "${k}"`);
for (const h of manifest.hooks) assert(keys.includes(h), `manifest declares hook "${h}" but index.mjs does not export it`);

assert.strictEqual(hooks.provider.id, manifest.id);
assert.strictEqual(typeof hooks.provider.fetch, 'function');
assert.strictEqual(hooks.provider.detect({ provider: manifest.id }), null);
assert.strictEqual(typeof hooks.search, 'function');

console.log('✓ smoke ok:', keys.join(', '));
