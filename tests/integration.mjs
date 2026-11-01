import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.TEST_BINARY ?? join(root, 'target', 'debug', `talos-companion${process.platform === 'win32' ? '.exe' : ''}`);
const setupToken = 'integration-setup-token-not-a-real-secret';
const passphrase = 'integration recovery passphrase';
const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
async function server(port, data) {
  let logs = '';
  const child = spawn(binary, { cwd: root, env: { ...process.env, DATA_DIR: data, PUBLIC_URL: `http://127.0.0.1:${port}`, LISTEN_ADDR: `127.0.0.1:${port}`, S3_LISTEN_ADDR: `127.0.0.1:${port + 1}`, SETUP_TOKEN: setupToken, BACKUP_PASSPHRASE: passphrase, BACKUP_INTERVAL_SECONDS: '86400' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error(logs); try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { child, logs: () => logs }; } catch {} await delay(100); }
  child.kill(); throw new Error(`Server did not start: ${logs}`);
}
async function stop(child) { if (child.exitCode !== null || child.signalCode !== null) return; const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
async function request(port, path, { body, cookie, method, setup, origin } = {}) {
  const form = body instanceof FormData;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: method ?? (body ? 'POST' : 'GET'), redirect: 'manual', headers: { 'x-requested-with': 'talos-companion', ...(body && !form ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(setup ? { 'x-setup-token': setupToken } : {}), ...(origin ? { origin } : {}) }, body: body ? (form ? body : JSON.stringify(body)) : undefined });
  return res;
}
async function login(port, email = 'admin@example.com', password = 'a very secure password') {
  const res = await request(port, '/api/login', { body: { email, password } }); assert.equal(res.status, 200, await res.clone().text()); return res.headers.get('set-cookie').split(';')[0];
}
async function s3(port, settings, method, path, body = '') {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8); const scope = `${day}/us-east-1/s3/aws4_request`; const host = `127.0.0.1:${port}`;
  const url = new URL(`http://${host}${path}`);
  const query = [...url.searchParams].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = `${method}\n${url.pathname}\n${query}\nhost:${host}\nx-amz-content-sha256:${sha(body)}\nx-amz-date:${date}\n\nhost;x-amz-content-sha256;x-amz-date\n${sha(body)}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${settings.s3_secret_key}`, day), 'us-east-1'), 's3'), 'aws4_request');
  return fetch(url, { method, headers: { 'x-amz-content-sha256': sha(body), 'x-amz-date': date, authorization: `AWS4-HMAC-SHA256 Credential=${settings.s3_access_key}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${hmac(key, stringToSign).toString('hex')}` }, ...(method !== 'GET' && method !== 'HEAD' ? { body } : {}) });
}

test('accounts, OIDC, signed S3 multipart, encrypted export, restart, and credential override restore', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'talos-companion-')); const children = [];
  try {
    const a = 18380, b = 18390; const source = await server(a, join(dir, 'source')); children.push(source.child);
    const account = { name: 'Homelab Admin', email: 'admin@example.com', password: 'a very secure password' };
    assert.equal((await request(a, '/api/setup', { body: account })).status, 403);
    assert.equal((await request(a, '/api/setup', { body: account, setup: true, origin: 'https://evil.example' })).status, 400);
    assert.equal((await request(a, '/api/setup', { body: account, setup: true })).status, 200);
    assert.equal((await request(a, '/api/setup', { body: account, setup: true })).status, 400);
    let cookie = await login(a);
    const initial = await (await request(a, '/api/me', { cookie })).json();
    assert.equal((await request(a, '/api/users', { cookie, body: { name: 'Member', email: 'member@example.com', password: 'member secure password', admin: false } })).status, 200);
    const memberCookie = await login(a, 'member@example.com', 'member secure password');
    assert.equal((await request(a, '/api/backups', { cookie: memberCookie })).status, 403);
    assert.equal((await request(a, '/api/backups')).status, 401);
    const callback = 'https://omni.example.com/oidc/consume';
    assert.equal((await request(a, '/api/oidc', { cookie, body: { redirect_uri: callback } })).status, 200);
    const settings = await (await request(a, '/api/overview', { cookie })).json();
    const discovery = await (await request(a, '/.well-known/openid-configuration')).json(); assert.equal(discovery.issuer, `http://127.0.0.1:${a}`);
    const verifier = 'x'.repeat(64); const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authQuery = new URLSearchParams({ client_id: 'omni', redirect_uri: callback, response_type: 'code', scope: 'openid email profile', state: 'caller-state', nonce: 'caller-nonce', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal((await request(a, `/oauth/authorize?${authQuery}`)).status, 303);
    const badQuery = new URLSearchParams(authQuery); badQuery.set('redirect_uri', `${callback}/evil`);
    assert.equal((await request(a, `/oauth/authorize?${badQuery}`, { cookie })).status, 400);
    const auth = await request(a, `/oauth/authorize?${authQuery}`, { cookie }); assert.equal(auth.status, 303);
    const target = new URL(auth.headers.get('location')); assert.equal(target.searchParams.get('state'), 'caller-state');
    const tokenForm = new URLSearchParams({ grant_type: 'authorization_code', code: target.searchParams.get('code'), client_id: 'omni', client_secret: settings.client_secret, redirect_uri: callback, code_verifier: verifier });
    const exchange = () => fetch(`http://127.0.0.1:${a}/oauth/token`, { method: 'POST', body: tokenForm });
    const tokensResponse = await exchange(); assert.equal(tokensResponse.status, 200); const tokens = await tokensResponse.json();
    assert.equal((await exchange()).status, 400, 'authorization code must be single use');
    const jwks = await (await request(a, '/oauth/jwks')).json(); const [header, payload, sig] = tokens.id_token.split('.');
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(sig, 'base64url')));
    const claims = JSON.parse(Buffer.from(payload, 'base64url')); assert.equal(claims.sub, initial.id); assert.equal(claims.nonce, 'caller-nonce');
    const info = await fetch(`http://127.0.0.1:${a}/oauth/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } }); assert.equal(info.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${a}/oauth/userinfo`, { headers: { authorization: `Bearer ${tokens.id_token}` } })).status, 401);
    for (let i = 0; i < 30; i++) { try { if ((await s3(a + 1, settings, 'GET', '/omni?list-type=2')).ok) break; } catch {} await delay(100); }
    assert.equal((await fetch(`http://127.0.0.1:${a + 1}/omni?list-type=2`)).status, 403, 'anonymous S3 access must be denied');
    const snapshot = 'test Omni encrypted etcd snapshot';
    const put = await s3(a + 1, settings, 'PUT', '/omni/cluster/snapshot', snapshot); assert.equal(put.status, 200, await put.text());
    assert.equal(await (await s3(a + 1, settings, 'GET', '/omni/cluster/snapshot')).text(), snapshot);
    const initiate = await s3(a + 1, settings, 'POST', '/omni/cluster/multipart?uploads='); assert.equal(initiate.status, 200); const uploadId = (await initiate.text()).match(/<UploadId>([^<]+)<\/UploadId>/)[1];
    const upload = await s3(a + 1, settings, 'PUT', `/omni/cluster/multipart?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, snapshot); assert.equal(upload.status, 200); const etag = upload.headers.get('etag');
    const complete = await s3(a + 1, settings, 'POST', `/omni/cluster/multipart?uploadId=${encodeURIComponent(uploadId)}`, `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`); assert.equal(complete.status, 200, await complete.text());
    assert.equal(await (await s3(a + 1, settings, 'GET', '/omni/cluster/multipart')).text(), snapshot);
    const vault = new FormData(); vault.append('file',new Blob(['test Omni encryption key material']), 'omni-key.txt');
    assert.equal((await request(a,'/api/vault',{cookie,body:vault})).status,200);
    const backup = await request(a, '/api/backups', { cookie, body: { destination: 'local' } }); assert.equal(backup.status, 200); const { name } = await backup.json();
    const exported = await request(a, `/api/backups/${name}`, { cookie }); const bytes = Buffer.from(await exported.arrayBuffer()); assert.ok(bytes.subarray(0, 9).equals(Buffer.from('TCBACKUP\x01'))); assert.ok(!bytes.includes(Buffer.from(account.email)));
    assert.equal((await request(a, '/api/restore', { setup: true, body: new FormData() })).status, 400);
    await stop(source.child);
    const restarted = await server(a, join(dir, 'source')); children.push(restarted.child); cookie = await login(a); assert.equal((await (await request(a, '/api/me', { cookie })).json()).id, initial.id);
    assert.equal((await request(a, '/api/me', { cookie: memberCookie })).status, 401, 'sessions must not survive restart');
    const dest = await server(b, join(dir, 'destination')); children.push(dest.child);
    const restore = async password => { const form = new FormData(); form.append('file', new Blob([bytes]), name); form.append('passphrase', password); form.append('account', JSON.stringify({ name: 'Recovered Admin', email: 'recovered@example.com', password: 'new secure recovered password' })); return request(b, '/api/restore', { setup: true, body: form }); };
    assert.equal((await restore('wrong passphrase')).status, 400); assert.equal((await (await request(b, '/api/status')).json()).initialized, false);
    const restored = await restore(passphrase); assert.equal(restored.status, 200, await restored.text());
    const recoveredCookie = await login(b, 'recovered@example.com', 'new secure recovered password');
    assert.equal(await (await request(b,'/api/vault/omni-key.txt',{cookie:recoveredCookie})).text(),'test Omni encryption key material');
    assert.equal((await (await request(b, '/api/me', { cookie: recoveredCookie })).json()).id, initial.id, 'override must preserve OIDC subject');
    assert.equal((await request(b, '/api/login', { body: account })).status, 401);
    assert.equal((await (await request(b, '/api/users', { cookie: recoveredCookie })).json()).length, 2);
    const restoredSettings = await (await request(b, '/api/overview', { cookie: recoveredCookie })).json(); assert.equal(restoredSettings.client_secret, settings.client_secret); assert.equal(restoredSettings.s3_secret_key, settings.s3_secret_key);
    for (let i = 0; i < 30; i++) { try { if ((await s3(b + 1, settings, 'GET', '/omni?list-type=2')).ok) break; } catch {} await delay(100); }
    assert.equal(await (await s3(b + 1, settings, 'GET', '/omni/cluster/snapshot')).text(), snapshot);
    assert.equal(await (await s3(b + 1, settings, 'GET', '/omni/cluster/multipart')).text(), snapshot);
    assert.equal((await request(b, '/api/password', { cookie: recoveredCookie, body: { current: 'new secure recovered password', password: 'another secure new password' } })).status, 200);
    assert.equal((await request(b, '/api/me', { cookie: recoveredCookie })).status, 401);
    await login(b, 'recovered@example.com', 'another secure new password');
  } finally { await Promise.all(children.map(stop)); await rm(dir, { recursive: true, force: true }); }
});
