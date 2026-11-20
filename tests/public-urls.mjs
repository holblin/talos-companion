import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server, stop, request, passphrase } from './helpers.mjs';
const fsReadManifest = () => readFile(new URL('../Cargo.toml', import.meta.url), 'utf8');
test('setup detects browser URL without Docker configuration, blocks mismatches and persists it', { timeout: 60000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'public-urls-'));
  const port = 18594;
  const origin = 'http://127.0.0.1:' + port;
  let child;
  try {
    ({ child } = await server(port, data, { PUBLIC_URL: undefined }));
    const check = await request(port, '/api/setup/check', { setup: true, origin, body: {} });
    assert.equal(check.status, 200, await check.clone().text());
    assert.equal((await check.json()).public_url, origin);
    const account = { name: 'Admin', email: 'admin@example.test', password: 'a very secure password', backup_passphrase_confirmation: passphrase };
    let response = await request(port, '/api/setup', { setup: true, origin, body: { ...account, public_url: 'https://different.example.test' } });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Installation blocked/);
    const status = await (await request(port, '/api/status')).json();
    assert.equal(status.initialized, false);
    const manifest = await fsReadManifest();
    assert.equal(status.version, manifest.match(/^version = "([^"]+)"/m)[1]);
    response = await request(port, '/api/setup', { setup: true, origin, body: { ...account, public_url: origin } });
    assert.equal(response.status, 200, await response.text());
    await stop(child);
    ({ child } = await server(port, data, { PUBLIC_URL: undefined }));
    assert.equal((await (await request(port, '/.well-known/openid-configuration')).json()).issuer, origin);
    assert.equal((await request(port, '/api/login', { origin: 'https://unrelated.example.test', body: { email: account.email, password: account.password } })).status, 400);
  } finally { if (child) await stop(child); await rm(data, { recursive: true, force: true }); }
});
