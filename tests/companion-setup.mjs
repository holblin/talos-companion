import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { server, stop, request, login, passphrase, s3 } from './helpers.mjs';

function trusted(port, ca, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port, ca, path }, res => {
      let body = ''; res.on('data', b => { body += b; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
test('Companion gets trusted HTTPS and activates its issuer before any Omni address is supplied', { timeout: 120000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'companion-https-'));
  const port = 18444;
  const endpoint = { profile: 'lan', companion_url: `https://127.0.0.1:${port}` };
  let child;
  try {
    ({ child } = await server(port, data));
    let response = await request(port, '/api/setup', { setup: true, body: { name: 'Admin', email: 'admin@example.com', password: 'a very secure password', backup_passphrase_confirmation: passphrase } });
    assert.equal(response.status, 200, await response.text());
    let cookie = await login(port);
    assert.equal((await request(port, '/api/companion/local', { body: endpoint })).status, 401);
    assert.equal((await request(port, '/api/companion/local', { cookie, origin: 'https://evil.example', body: endpoint })).status, 400);
    response = await request(port, '/api/companion/local', { cookie, body: endpoint });
    assert.equal(response.status, 200, await response.text());
    const ca = await (await request(port, '/api/companion/ca', { cookie })).text();
    assert.match(ca, /BEGIN CERTIFICATE/); assert.doesNotMatch(ca, /PRIVATE KEY/);
    assert.equal((await trusted(port, ca, '/healthz')).status, 200);
    await assert.rejects(trusted(port, undefined, '/healthz'), /certificate/i, 'untrusted clients must reject local TLS');
    response = await request(port, '/api/companion/check', { cookie, body: endpoint });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await (await request(port, '/api/omni/connection', { cookie })).json()).backend_origin, '');
    response = await request(port, '/api/companion/activate', { cookie, body: { ...endpoint, companion_url: `http://127.0.0.1:${port}` } });
    assert.equal(response.status, 400);
    assert.equal((await request(port, '/api/companion/activate', { cookie, body: endpoint })).status, 400, 'Omni requires a registered access method');
    for (const profile of ['lan', 'tailscale', 'cloudflare']) {
      response = await request(port, '/api/companion/access', { cookie, body: { ...endpoint, profile } });
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal((await request(port, '/api/companion/access')).status, 401);
    assert.equal((await request(port, '/api/companion/access', { cookie, origin: 'https://evil.example', body: endpoint })).status, 400);
    const catalog = await (await request(port, '/api/companion/access', { cookie })).json();
    assert.equal(catalog.accesses.length, 3, 'all three methods coexist');
    assert.ok(catalog.accesses.every(a => a.verified_at > 0));
    assert.equal(catalog.active_issuer, `http://127.0.0.1:${port}`, 'adding access does not change the canonical issuer');
    const refreshedProvider = { ...endpoint, profile: 'cloudflare', omni_url: 'https://omni.new.example.test', s3_endpoint: 'https://s3.new.example.test' };
    await writeFile(join(data, 'connections', 'private', 'cloudflare-active.json'), JSON.stringify(refreshedProvider));
    const refreshed = await (await request(port, '/api/companion/access', { cookie, body: { ...endpoint, profile: 'cloudflare' } })).json();
    assert.equal(refreshed.integration.s3_endpoint, refreshedProvider.s3_endpoint, 'reconfiguration takes the latest provider endpoints');
    assert.equal(refreshed.integration.omni_url, refreshedProvider.omni_url);
    const callback = 'https://omni.example.test/oidc/consume';
    await request(port, '/api/oidc', { cookie, body: { redirect_uri: callback } });
    const config = await (await request(port, '/api/overview', { cookie })).json();
    const authPath = '/oauth/authorize?' + new URLSearchParams({ client_id: config.client_id, redirect_uri: callback, response_type: 'code', scope: 'openid' });
    const oldCode = new URL((await request(port, authPath, { cookie })).headers.get('location')).searchParams.get('code');
    response = await request(port, '/api/companion/activate', { cookie, body: endpoint });
    assert.equal(response.status, 200, await response.text());
    const exchange = code => fetch(`http://127.0.0.1:${port}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: config.client_id, client_secret: config.client_secret }) });
    assert.equal((await exchange(oldCode)).status, 400, 'activation revokes old authorization codes');
    const code = new URL((await request(port, authPath, { cookie })).headers.get('location')).searchParams.get('code');
    const tokens = await (await exchange(code)).json();
    assert.equal(JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url')).iss, endpoint.companion_url);
    const discovery = JSON.parse((await trusted(port, ca, '/.well-known/openid-configuration')).body);
    assert.equal(discovery.issuer, endpoint.companion_url);
    assert.equal(discovery.jwks_uri, endpoint.companion_url + '/oauth/jwks');
    const status = await (await request(port, '/api/omni', { cookie })).json();
    assert.equal(status.active_issuer, endpoint.companion_url); assert.equal(status.restart_pending, false);
    assert.equal(status.defaults.s3_endpoint, endpoint.companion_url, 'local S3 is automatic on the same HTTPS port');
    const challenge = 'a'.repeat(64);
    const identity = await trusted(port, ca, '/.well-known/talos-companion?challenge=' + challenge);
    assert.equal(JSON.parse(identity.body).service, 's3');
    const overview = await (await request(port, '/api/overview', { cookie })).json();
    assert.equal((await s3(port, overview, 'PUT', '/omni/https-roundtrip', 'backup content')).status, 200);
    assert.equal((await trusted(port, ca, '/omni/https-roundtrip')).status, 403, 'HTTPS never bypasses S3 authentication');
    response = await request(port, '/api/omni/check', { cookie, body: { ...endpoint, omni_url: `http://127.0.0.1:${port}`, s3_endpoint: endpoint.companion_url } });
    const checks = await response.json(); assert.ok(checks.checks.every(c => c.ok), JSON.stringify(checks));
    const privatePath = join(data, 'connections', 'private', 'local-https.json');
    const privateCert = JSON.parse(await readFile(privatePath, 'utf8'));
    const impostor = https.createServer({ key: privateCert.key, cert: privateCert.cert }, (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ service: 'companion', proof: 'wrong' })); });
    await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
    try {
      const wrong = { ...endpoint, companion_url: `https://127.0.0.1:${impostor.address().port}` };
      assert.equal((await request(port, '/api/companion/activate', { cookie, body: wrong })).status, 400, 'a trusted TLS endpoint with the wrong installation identity cannot become issuer');
    } finally { await new Promise(resolve => impostor.close(resolve)); }
    let validProxy = true;
    const accessProxy = https.createServer({ key: privateCert.key, cert: privateCert.cert }, async (req, res) => {
      if (!validProxy) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ service: 'companion', proof: 'wrong' })); return; }
      const upstream = await fetch(`http://127.0.0.1:${port}${req.url}`);
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text());
    });
    await new Promise(resolve => accessProxy.listen(0, '127.0.0.1', resolve));
    const proxyEndpoint = { profile: 'cloudflare', companion_url: `https://127.0.0.1:${accessProxy.address().port}` };
    try {
      assert.equal((await request(port, '/api/companion/access', { cookie, body: proxyEndpoint })).status, 200);
      validProxy = false;
      assert.equal((await request(port, '/api/companion/access', { cookie, body: proxyEndpoint })).status, 400);
      const afterFailure = await (await request(port, '/api/companion/access', { cookie })).json();
      assert.equal(afterFailure.accesses.find(a => a.integration.profile === 'cloudflare').verified_at, 0, 'failed checks mark only that method as needing verification');
      assert.ok(afterFailure.accesses.filter(a => a.integration.profile !== 'cloudflare').every(a => a.verified_at > 0));
      assert.equal(afterFailure.active_issuer, endpoint.companion_url, 'a failed alternative does not change the selected issuer');
      assert.equal((await request(port, '/api/companion/activate', { cookie, body: proxyEndpoint })).status, 400, 'an access method needing verification cannot be selected');
    } finally { await new Promise(resolve => accessProxy.close(resolve)); }
    await request(port, '/api/companion/local', { cookie, body: endpoint });
    assert.equal(await (await request(port, '/api/companion/ca', { cookie })).text(), ca, 'retry preserves trust');
    const state = JSON.parse(await readFile(join(data, 'state.json'), 'utf8'));
    assert.equal(state.integration.companion_url, endpoint.companion_url);
    assert.equal((await (await request(port, '/api/companion/access', { cookie })).json()).accesses.length, 3);
    await stop(child); ({ child } = await server(port, data));
    cookie = await login(port);
    assert.equal((await (await request(port, '/api/companion/access', { cookie })).json()).accesses.length, 3, 'access methods survive restart');
    assert.equal(JSON.parse((await trusted(port, ca, '/.well-known/openid-configuration')).body).issuer, endpoint.companion_url);
    assert.equal((await request(port, '/api/companion/check', { cookie, body: endpoint, origin: `http://127.0.0.1:${port}` })).status, 200, 'bootstrap origin remains accepted after restart');
  } finally { if (child) await stop(child); await rm(data, { recursive: true, force: true }); }
});
