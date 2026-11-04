import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {server,stop,request,login,passphrase} from './helpers.mjs';
test('owner recovery is offline, preserves identity and only explicit recovery prints a password', {timeout:120000},async()=>{
  const data=await mkdtemp(join(tmpdir(),'companion-owner-recovery-'));
  let child;
  const binary=process.env.TEST_BINARY??resolve('target','debug',process.platform==='win32'?'talos-companion.exe':'talos-companion');
  const recover=()=>spawnSync(binary,['--reset-admin-password'],{encoding:'utf8',env:{...process.env,DATA_DIR:data,SETUP_TOKEN:'integration-setup-token-not-a-real-secret',BACKUP_PASSPHRASE:passphrase}});
  try{
    const running=await server(18430,data);child=running.child;
    assert.equal((await request(18430,'/api/setup',{setup:true,body:{name:'Recovery Test',email:'recovery@example.test',password:'initial recovery test password',backup_passphrase_confirmation:passphrase}})).status,200);
    const before=JSON.parse(await readFile(join(data,'state.json'),'utf8'));
    assert.notEqual(recover().status,0);
    await stop(child);child=undefined;
    const result=recover();assert.equal(result.status,0,result.stderr);
    const password=result.stdout.match(/New temporary password: ([a-f0-9]{64})/)?.[1];assert.ok(password);
    const after=JSON.parse(await readFile(join(data,'state.json'),'utf8'));
    assert.equal(after.users[0].id,before.users[0].id);assert.equal(after.signing_key,before.signing_key);assert.equal(after.client_secret,before.client_secret);assert.notEqual(after.users[0].password_hash,before.users[0].password_hash);
    const restarted=await server(18430,data);child=restarted.child;
    await login(18430,'recovery@example.test',password);
    assert.equal((await request(18430,'/api/login',{body:{email:'recovery@example.test',password:'initial recovery test password'}})).status,401);
    assert.ok(!restarted.logs().includes(password));
  }finally{if(child)await stop(child);await rm(data,{recursive:true,force:true});}
});
