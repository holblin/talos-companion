import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {server,stop,request,login,passphrase} from './helpers.mjs';

test('guided connections require admin/CSRF, bind jobs, and check receiver identity and signed bucket access', {timeout:120000}, async()=>{
  const data=await mkdtemp(join(tmpdir(),'companion-connections-'));
  const control=join(data,'control'); await mkdir(control);
  const port=18436; let child;
  let credentialRequests=0;
  const impostor=createServer((req,res)=>{
    if(req.headers.authorization)credentialRequests++;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'s3',proof:'wrong'}));
  });
  await new Promise(resolve=>impostor.listen(0,'127.0.0.1',resolve));
  const fakeOrigin=`http://127.0.0.1:${impostor.address().port}`;
  const info=()=>writeFile(join(control,'agent.json'),JSON.stringify({updated_at:Math.floor(Date.now()/1000),s3_origin:`http://127.0.0.1:${port+1}`,omni_origin:fakeOrigin}));
  try {
    const running=await server(port,data,{CONNECTION_CONTROL_DIR:control,S3_PUBLIC_URL:`http://127.0.0.1:${port+1}`});child=running.child;
    assert.equal((await request(port,'/api/setup',{setup:true,body:{name:'Connections Test',email:'connections@example.test',password:'initial connections password',backup_passphrase_confirmation:passphrase}})).status,200);
    const cookie=await login(port,'connections@example.test','initial connections password');
    const connect=(body)=>request(port,'/api/omni/connection',{cookie,body});
    assert.equal((await request(port,'/api/omni/connection')).status,401);
    assert.equal((await connect({profile:'tailscale'})).status,400);
    await info();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/omni/connection`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({profile:'tailscale'})})).status,400);
    assert.equal((await connect({profile:'cloudflare',domain:'https://example.test/path'})).status,400);
    const located=await request(port,'/api/omni/location',{cookie,body:{address:fakeOrigin+'/login?next=home'}});assert.equal(located.status,200);assert.equal((await located.json()).origin,fakeOrigin);
    assert.equal((await request(port,'/api/omni/location',{cookie,body:{address:fakeOrigin,certificate:'-----BEGIN PRIVATE KEY-----'}})).status,400);
    assert.equal((await request(port,'/api/omni/location',{body:{address:fakeOrigin}})).status,401);
    const started=await connect({profile:'cloudflare',domain:'lab.example.test'});assert.equal(started.status,200);
    const {id}=await started.json();const job=JSON.parse(await readFile(join(control,'request.json'),'utf8'));assert.equal(job.id,id);
    assert.equal((await connect({profile:'tailscale'})).status,400,'parallel provider jobs are rejected');
    let result=await (await request(port,'/api/omni/connection',{cookie})).json();assert.equal(result.connection.state,'starting');
    await writeFile(join(control,'status.json'),JSON.stringify({id:'stale-job',state:'connected',profile:'tailscale',message:'stale',expires_at:job.expires_at}));
    result=await (await request(port,'/api/omni/connection',{cookie})).json();assert.equal(result.connection.state,'starting');
    await writeFile(join(control,'status.json'),JSON.stringify({id,state:'authorizing',profile:'cloudflare',auth_url:'https://dash.cloudflare.com/argotunnel?test-only',message:'Approve provider',expires_at:job.expires_at}));
    result=await (await request(port,'/api/omni/connection',{cookie})).json();assert.equal(result.connection.state,'authorizing');
    const integration={profile:'lan',companion_url:`http://127.0.0.1:${port}`,omni_url:fakeOrigin,s3_endpoint:`http://127.0.0.1:${port+1}`};
    const defaults=await(await request(port,'/api/omni',{cookie})).json();assert.equal(defaults.defaults.companion_url,integration.companion_url);assert.equal(defaults.defaults.s3_endpoint,integration.s3_endpoint);
    for(let n=0;n<40;n++){try{if((await fetch(`${integration.s3_endpoint}/.well-known/talos-companion?challenge=${'a'.repeat(64)}`)).ok)break;}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal((await request(port,'/api/omni/check',{body:integration})).status,401);
    const check=await request(port,'/api/omni/check',{cookie,body:integration});assert.equal(check.status,200,await check.clone().text());
    const checks=await check.json();assert.deepEqual(checks.checks.map(x=>[x.service,x.ok]),[['Companion',true],['Omni',true],['S3',true]]);assert.equal(checks.omni_to_s3_verified,false);
    const alias={...integration,companion_url:'http://localhost:'+port};
    assert.equal((await request(port,'/api/omni/connection/finish',{cookie,body:{...alias,companion_url:alias.companion_url+'/'}})).status,200);
    assert.equal((await request(port,'/api/login',{origin:alias.companion_url,body:{email:'connections@example.test',password:'initial connections password'}})).status,200,'verified public UI origin works without changing Docker PUBLIC_URL');
    assert.equal((await request(port,'/api/omni',{cookie})).status,200);
    assert.equal((await(await request(port,'/api/omni',{cookie})).json()).active_issuer,integration.companion_url,'network setup preserves the OIDC issuer');
    assert.equal((await request(port,'/api/login',{origin:'https://untrusted.example.test',body:{email:'connections@example.test',password:'initial connections password'}})).status,400);
    const savedPath=join(data,'connections','settings.json');const saved=JSON.parse(await readFile(savedPath,'utf8'));
    saved.integration.companion_url='https://verified-test-only.example.test';await writeFile(savedPath,JSON.stringify(saved));
    const secureLogin=await request(port,'/api/login',{origin:saved.integration.companion_url,body:{email:'connections@example.test',password:'initial connections password'}});assert.equal(secureLogin.status,200);assert.match(secureLogin.headers.get('set-cookie'),/; Secure/);
    const wrong=await(await request(port,'/api/omni/check',{cookie,body:{...integration,companion_url:fakeOrigin,s3_endpoint:fakeOrigin}})).json();
    assert.equal(wrong.checks.find(x=>x.service==='Companion').ok,false);assert.equal(wrong.checks.find(x=>x.service==='S3').ok,false);assert.equal(credentialRequests,0,'no signed S3 requests are sent to an unverified destination');
    const discovered=await request(port,'/api/omni/discover',{cookie,body:{primary_config:'services:\n  api:\n    advertisedURL: https://omni.example.test\n'}});assert.equal((await discovered.json()).omni_url,'https://omni.example.test');
    await writeFile(join(control,'request.json'),JSON.stringify({...job,expires_at:0}));
    result=await(await request(port,'/api/omni/connection',{cookie})).json();assert.equal(result.connection.state,'expired');assert.equal(result.connection.auth_url,null);
    await info();assert.equal((await connect({profile:'tailscale'})).status,200,'expired jobs can be retried');
    assert.equal((await request(port,'/api/omni/connection',{cookie,method:'DELETE'})).status,200);
    assert.equal((await(await request(port,'/api/omni/connection',{cookie})).json()).connection.state,'expired');
    assert.equal((await connect({profile:'tailscale'})).status,200,'canceled authorization can be restarted');
    assert.ok(!running.logs().includes('test-only'));
  } finally {if(child)await stop(child);await new Promise(resolve=>impostor.close(resolve));await rm(data,{recursive:true,force:true});}
});
