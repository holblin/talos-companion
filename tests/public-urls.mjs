import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server, stop, request, login, passphrase } from './helpers.mjs';
const fsReadManifest = () => readFile(new URL('../Cargo.toml', import.meta.url), 'utf8');

test('provider cleanup is explicit, admin-only, request-bound and preserves addresses on failure', { timeout: 60000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'provider-cleanup-'));
  const control = join(data, 'connections', 'control');
  const privateDir = join(data, 'connections', 'private');
  await mkdir(control, { recursive: true });
  await mkdir(privateDir, { recursive: true });
  const port = 18595;
  let child;
  const cloud = { profile: 'cloudflare', companion_url: 'https://companion.example.test', omni_url: 'https://omni.example.test', s3_endpoint: 'https://s3.example.test' };
  const tail = { profile: 'tailscale', companion_url: 'https://companion.example.ts.net', omni_url: 'https://companion.example.ts.net:8443', s3_endpoint: 'https://companion.example.ts.net:10000' };
  const settingsPath = join(data, 'connections', 'settings.json');
  const seed = async () => {
    await writeFile(settingsPath, JSON.stringify({ omni_origin: '', integration: cloud, accesses: [cloud, tail].map(integration => ({ integration, verified_at: 100 })), removed_urls: [] }));
    await writeFile(join(privateDir, 'cloudflare-active.json'), JSON.stringify(cloud));
    await writeFile(join(control, 'agent.json'), JSON.stringify({ updated_at: Math.floor(Date.now() / 1000), providers: ['cloudflare', 'tailscale'] }));
  };
  try {
    ({ child } = await server(port, data, { CONNECTION_CONTROL_DIR: control }));
    assert.equal((await request(port, '/api/setup', { setup: true, body: { name: 'Cleanup Test', email: 'cleanup@example.test', password: 'initial cleanup password', backup_passphrase_confirmation: passphrase } })).status, 200);
    const cookie = await login(port, 'cleanup@example.test', 'initial cleanup password');
    await seed();
    const remove = (body, extra = {}) => request(port, '/api/companion/access', { method: 'DELETE', cookie, body, ...extra });
    assert.equal((await remove({ ...cloud, cleanup_provider: true }, { cookie: undefined })).status, 422, 'strict request schema rejects unrelated fields');
    const body = { profile: cloud.profile, companion_url: cloud.companion_url };
    assert.equal((await remove({ ...body, cleanup_provider: true }, { cookie: undefined })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/companion/access`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    assert.equal((await remove(body)).status, 200);
    await assert.rejects(readFile(join(control, 'cleanup-request.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(privateDir, 'cloudflare-active.json'))).companion_url, cloud.companion_url);
    await seed();
    assert.equal((await remove({ ...body, cleanup_provider: true }, { origin: cloud.companion_url })).status, 400, 'cannot disconnect the browser route');
    assert.equal((await remove({ profile: 'lan', companion_url: 'https://local.example.test', cleanup_provider: true })).status, 400);
    const respond = async (state) => {
      const previous = await readFile(join(control, 'cleanup-request.json'), 'utf8').catch(() => '');
      const response = remove({ ...body, cleanup_provider: true });
      let job;
      for (let attempt = 0; attempt < 80; attempt++) {
        const text = await readFile(join(control, 'cleanup-request.json'), 'utf8').catch(() => '');
        if (text && text !== previous) { job = JSON.parse(text); break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(job, 'cleanup request delivered to connector');
      assert.equal(job.profile, 'cloudflare');
      await writeFile(join(control, 'cleanup-status.json'), JSON.stringify({ id: 'stale', state: 'succeeded', message: 'wrong job' }));
      let settled = false;
      void response.then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(settled, false, 'stale status cannot confirm cleanup');
      await writeFile(join(control, 'cleanup-status.json'), JSON.stringify({ id: job.id, state, message: state === 'failed' ? 'Provider cleanup failed; credentials retained for retry.' : 'Provider cleaned up.' }));
      return response;
    };
    assert.equal((await respond('failed')).status, 400);
    assert.equal(JSON.parse(await readFile(settingsPath)).accesses.length, 2);
    const success = await respond('succeeded');
    assert.equal(success.status, 200, await success.clone().text());
    const saved = JSON.parse(await readFile(settingsPath));
    assert.deepEqual(saved.accesses.map(access => access.integration.profile), ['tailscale']);
    assert.equal(saved.integration, null);
    assert.ok(saved.removed_urls.includes(cloud.companion_url));
  } finally { if (child) await stop(child); await rm(data, { recursive: true, force: true }); }
});
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
