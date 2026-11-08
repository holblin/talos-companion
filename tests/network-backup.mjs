import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server, stop, request, login, passphrase } from './helpers.mjs';

test('native share configuration requires admin, validates paths, and preserves local backups on remote failure', {timeout: 120000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-network-'));
  const port = 18780;
  let app;
  const config = {protocol:'nfs',host:'127.0.0.1',share:'/exports/backups',directory:'',username:'',password:'private-share-password',uid:99,gid:100};
  try {
    app = await server(port, dir);
    assert.equal((await request(port, '/api/setup', {setup:true,body:{name:'Admin',email:'admin@example.com',password:'a very secure password',backup_passphrase_confirmation:passphrase}})).status, 200);
    assert.equal((await request(port, '/api/backups/network', {body:config})).status, 401);
    let cookie = await login(port);
    assert.equal((await request(port, '/api/backups/network', {cookie,body:{...config,directory:'../escape'}})).status, 400);
    assert.equal((await request(port, '/api/backups', {cookie,body:{destination:'network'}})).status, 400);
    const settings = await (await request(port, '/api/settings', {cookie})).json();
    assert.equal((await request(port, '/api/settings', {cookie,body:{...settings,schedule:{...settings.schedule,destination:'network'}}})).status, 400);
    // Model an already configured NAS that becomes unavailable after a restart.
    await stop(app.child);
    const statePath = join(dir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.network = config;
    await writeFile(statePath, JSON.stringify(state));
    app = await server(port, dir);
    cookie = await login(port);
    const overview = await (await request(port, '/api/overview', {cookie})).json();
    assert.equal(overview.network.protocol, 'nfs');
    assert.equal(overview.network.password, undefined);
    assert.equal(JSON.stringify(overview).includes(config.password), false);
    const failed = await request(port, '/api/backups/network', {cookie,body:{...config,protocol:'unsupported'}});
    assert.equal(failed.status, 400);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).network, config);
    const response = await request(port, '/api/backups', {cookie,body:{destination:'network'}});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.warning, /Remote transfer/);
    assert.ok((await readFile(join(dir, 'backups', result.name))).length > 0);
    assert.equal((await request(port, `/api/backups/${result.name}`, {cookie})).status, 200);
  } finally {
    if (app) await stop(app.child);
    await rm(dir, {recursive:true,force:true});
  }
});
