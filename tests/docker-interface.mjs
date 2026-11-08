import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

// Keep normal installation small: user-facing features belong in the app's
// wizard, not in new environment variables, ports, mounts, or sidecar services.
// A genuine deployment change requires reviewing this explicit contract.
const reason='Keep Docker for deployment settings; put user setup in the in-app wizard instead of adding container parameters.';
const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const sorted=values=>[...values].sort();

for(const [file,variables,environment] of [
  ['compose.yaml',['PUID','PGID','WEB_PORT','S3_PORT','PUBLIC_URL','SETUP_TOKEN','BACKUP_PASSPHRASE','DATA_PATH'],['PUBLIC_URL','SETUP_TOKEN','BACKUP_PASSPHRASE','RUST_LOG']],
  ['deploy/compose.hub.yaml',['TALOS_COMPANION_IMAGE','PUID','PGID','WEB_PORT','S3_PORT','PUBLIC_URL','SETUP_TOKEN','BACKUP_PASSPHRASE','DATA_PATH'],['PUBLIC_URL','SETUP_TOKEN','BACKUP_PASSPHRASE']],
]) test(`${file} keeps the existing Docker setup contract`,()=>{
  const source=read(file);
  assert.deepEqual(sorted(new Set([...source.matchAll(/\$\{([A-Z0-9_]+)/g)].map(m=>m[1]))),sorted(variables),reason);
  assert.deepEqual([...source.matchAll(/^  ([a-z][a-z_-]*):/gm)].map(m=>m[1]),['companion'],reason);
  const block=/^    environment:\r?\n((?:^      .*\r?\n)+)/m.exec(source)?.[1]??'';
  const lines=block.trim().split(/\r?\n/);
  const keys=[...block.matchAll(/^      ([A-Z_]+):/gm)].map(m=>m[1]);
  assert.equal(lines.length,keys.length,reason);
  assert.deepEqual(sorted(keys),sorted(environment),reason);
  assert.deepEqual(sorted([...source.matchAll(/^      - "([^"]+)"/gm)].map(m=>m[1])),sorted(['${WEB_PORT:-8080}:8080','${S3_PORT:-9000}:9000','${DATA_PATH:-./data}:/data']),reason);
  assert.deepEqual([...source.matchAll(/^        target: (.+)$/gm)].map(m=>m[1].trim()),[],reason);
});

for(const file of ['deploy/unraid/talos-companion.xml','dist/community-apps/templates/talos-companion.xml'].filter(path=>existsSync(resolve(root,path)))) {
  test(`${file} adds no Unraid parameters or privileges`,()=>{
    const source=read(file);
    const parameters=[...source.matchAll(/<Config\b([^>]*)>/g)].map(([,attrs])=>{
      const attr=name=>new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
      return `${attr('Type')}:${attr('Target')}`;
    });
    assert.deepEqual(sorted(parameters),sorted(['Port:8080','Port:9000','Path:/data','Path:/omni-managed','Variable:PUBLIC_URL','Variable:SETUP_TOKEN','Variable:BACKUP_PASSPHRASE']),reason);
    assert.equal(/<ExtraParams>([^<]*)<\/ExtraParams>/.exec(source)?.[1],'--user 99:100 --read-only --cap-drop ALL --security-opt no-new-privileges:true',reason);
    assert.match(source,/<Privileged>false<\/Privileged>/,reason);
  });
}
