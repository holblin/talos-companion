#!/usr/bin/env bash
# Owner-run provisioning; never executed by the web application. Requires Unraid root.
set -euo pipefail
umask 077
PROFILE=lan
PHASE=prepare
BASE=/mnt/user/appdata/talos-omni-home
COMPANION_DATA=/mnt/user/appdata/talos-companion
HOST_IP=
COMPANION_HOST=
OMNI_HOST=
CF_ZONE_ID=
ACME_EMAIL=
EULA_NAME=
EULA_EMAIL=
IMAGE=holblin/talos-companion:0.3.7
while (($#)); do
  case "$1" in
    --profile) PROFILE=$2; shift 2;;
    --phase) PHASE=$2; shift 2;;
    --host-ip) HOST_IP=$2; shift 2;;
    --base) BASE=$2; shift 2;;
    --companion-data) COMPANION_DATA=$2; shift 2;;
    --companion-host) COMPANION_HOST=$2; shift 2;;
    --omni-host) OMNI_HOST=$2; shift 2;;
    --cloudflare-zone) CF_ZONE_ID=$2; shift 2;;
    --acme-email) ACME_EMAIL=$2; shift 2;;
    --eula-name) EULA_NAME=$2; shift 2;;
    --eula-email) EULA_EMAIL=$2; shift 2;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2;;
  esac
done
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die 'Run this owner-controlled helper as root on Unraid.'
[[ $PROFILE =~ ^(lan|cloudflare|tailscale)$ && $PHASE =~ ^(prepare|apply|renew)$ ]] || die 'Invalid profile or phase.'
[[ $BASE == /mnt/* && $BASE != *..* && $COMPANION_DATA == /mnt/* && $COMPANION_DATA != *..* ]] || die 'Use absolute dedicated /mnt paths without ..'
for cmd in docker jq openssl curl sha256sum; do command -v "$cmd" >/dev/null || die "Missing $cmd"; done
[[ $HOST_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die 'Supply --host-ip with the literal LAN IPv4 address.'
IFS=. read -r -a octets <<< "$HOST_IP"
for octet in "${octets[@]}"; do ((10#$octet <= 255)) || die 'Invalid IPv4 address'; done
[[ -f $COMPANION_DATA/state.json ]] || die 'Finish Companion first-run setup before provisioning Omni.'
CERTS="$BASE/profiles/$PROFILE/tls"
if [[ -d $BASE && ! -f $BASE/.talos-companion-managed && -n $(find "$BASE" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  die 'Target is nonempty and is not owned by this helper. Choose a new dedicated --base.'
fi
mkdir -p "$BASE" "$BASE/config" "$BASE/data/secondary-storage" "$BASE/keys" "$CERTS" "$BASE/managed" "$BASE/rollback" "$BASE/proxy-data" "$BASE/proxy-config"
chmod 700 "$BASE" "$BASE/config" "$BASE/keys" "$CERTS" "$BASE/rollback"
touch "$BASE/.talos-companion-managed"
# Companion receives only the overlay directory, not Omni's keys or data.
chown 99:100 "$BASE/managed"
chmod 700 "$BASE/managed"

if [[ $PROFILE == lan ]]; then
  COMPANION_HOST=$HOST_IP; OMNI_HOST=$HOST_IP
  if [[ ! -f $CERTS/root-ca.key ]]; then
    [[ ! -f $CERTS/root-ca.crt && ! -d $BASE/data/etcd/member ]] || die 'LAN CA key is missing. Restore the original key; do not silently replace an existing trust authority.'
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 -subj '/CN=Talos Companion Home LAN Root' \
      -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
      -keyout "$CERTS/root-ca.key" -out "$CERTS/root-ca.crt" 2>/dev/null
  fi
  if [[ ! -f $CERTS/tls.crt ]] || ! openssl x509 -in "$CERTS/tls.crt" -noout -checkip "$HOST_IP" >/dev/null 2>&1 || ! openssl verify -CAfile "$CERTS/root-ca.crt" "$CERTS/tls.crt" >/dev/null 2>&1 || ! openssl x509 -in "$CERTS/tls.crt" -noout -checkend 2592000; then
    openssl req -new -newkey rsa:3072 -nodes -subj '/CN=Talos Companion Home' -keyout "$CERTS/tls.key" -out "$CERTS/tls.csr" 2>/dev/null
    printf 'subjectAltName=IP:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$HOST_IP" > "$CERTS/leaf.ext"
    openssl x509 -req -in "$CERTS/tls.csr" -CA "$CERTS/root-ca.crt" -CAkey "$CERTS/root-ca.key" -CAcreateserial -days 365 -sha256 -extfile "$CERTS/leaf.ext" -out "$CERTS/tls.crt" 2>/dev/null
  fi
  cp "$CERTS/root-ca.crt" "$BASE/managed/root-ca.crt"
  chown 99:100 "$BASE/managed/root-ca.crt"
elif [[ $PROFILE == cloudflare ]]; then
  [[ $COMPANION_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ && $OMNI_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ && $COMPANION_HOST != "$OMNI_HOST" ]] || die 'Provide two distinct DNS hostnames.'
  [[ $CF_ZONE_ID =~ ^[a-fA-F0-9]{32}$ && $ACME_EMAIL == *@* ]] || die 'Provide Cloudflare zone ID and ACME contact email.'
  mkdir -p "$BASE/acme"
  if [[ $PHASE == prepare ]]; then
    read -r -s -p 'Cloudflare token (DNS:Edit + Zone:Read, this zone only): ' CF_Token; printf '\n'
    [[ -n $CF_Token ]] || die 'No token supplied.'
    for name in "$COMPANION_HOST" "$OMNI_HOST"; do
      response=$(curl -fsS -H "Authorization: Bearer $CF_Token" "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=A&name=$name")
      jq -e '.success == true' <<< "$response" >/dev/null || die 'Cloudflare DNS lookup failed.'
      record=$(jq -r '.result[0].id // empty' <<< "$response")
      body=$(jq -nc --arg name "$name" --arg ip "$HOST_IP" '{type:"A",name:$name,content:$ip,ttl:300,proxied:false}')
      if [[ -n $record ]]; then method=PUT; suffix="/$record"; else method=POST; suffix=; fi
      curl -fsS -X "$method" -H "Authorization: Bearer $CF_Token" -H 'Content-Type: application/json' \
        --data "$body" "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records$suffix" | jq -e '.success == true' >/dev/null || die 'Cloudflare DNS update failed.'
    done
    export CF_Token CF_Zone_ID=$CF_ZONE_ID
    docker run --rm -v "$BASE/acme:/acme.sh" -e CF_Token -e CF_Zone_ID neilpang/acme.sh:latest \
      --issue --dns dns_cf --server letsencrypt --keylength ec-256 --accountemail "$ACME_EMAIL" -d "$COMPANION_HOST" -d "$OMNI_HOST"
    unset CF_Token CF_Zone_ID
  elif [[ $PHASE == renew ]]; then
    docker run --rm -v "$BASE/acme:/acme.sh" neilpang/acme.sh:latest --cron
  fi
  docker run --rm -v "$BASE/acme:/acme.sh" -v "$CERTS:/certs" neilpang/acme.sh:latest \
    --install-cert --ecc -d "$COMPANION_HOST" --key-file /certs/tls.key --fullchain-file /certs/tls.crt
else
  # The host's existing authenticated Tailscale installation owns network access.
  # No auth key is stored in Companion and no new tailnet device is silently enrolled.
  command -v tailscale >/dev/null || die 'Install/sign in to Tailscale on Unraid first, enable MagicDNS and HTTPS certificates, then rerun.'
  ts_status=$(tailscale status --json)
  [[ $(jq -r .BackendState <<< "$ts_status") == Running ]] || die 'Sign in to Tailscale first.'
  COMPANION_HOST=$(jq -r .Self.DNSName <<< "$ts_status"); COMPANION_HOST=${COMPANION_HOST%.}; OMNI_HOST=$COMPANION_HOST
  [[ $COMPANION_HOST == *.ts.net ]] || die 'Enable MagicDNS and HTTPS certificates in the tailnet.'
  tailscale cert --cert-file "$CERTS/tls.crt" --key-file "$CERTS/tls.key" "$COMPANION_HOST"
fi
chmod 600 "$CERTS/tls.key"
COMPANION_URL="https://$COMPANION_HOST:18443"
OMNI_URL="https://$OMNI_HOST:19443"
S3_URL="https://$COMPANION_HOST:19444"
if [[ $PHASE == renew ]]; then
  docker restart talos-home-proxy omni-companion >/dev/null
  printf 'Certificates refreshed. Managed proxy and Omni restarted.\n'
  exit 0
fi

if [[ ! -f $BASE/keys/omni.asc ]]; then
  [[ ! -d $BASE/data/etcd/member ]] || die 'Database exists but encryption key is missing. Restore the original key; never generate a replacement.'
  docker run --rm -v "$BASE/keys:/keys" alpine:3 sh -ec \
    'apk add --no-cache gnupg >/dev/null; export GNUPGHOME=/keys/gnupg; mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"; gpg --batch --pinentry-mode loopback --passphrase "" --quick-generate-key "Talos Companion Omni" default default never; gpg --batch --armor --export-secret-keys "Talos Companion Omni" > /keys/omni.asc; chmod 600 /keys/omni.asc'
fi
if [[ ! -f $BASE/account-id ]]; then
  [[ ! -d $BASE/data/etcd/member ]] || die 'Database exists but account ID is missing. Restore the original UUID.'
  cat /proc/sys/kernel/random/uuid > "$BASE/account-id"
fi
[[ -n $(cat "$BASE/account-id") ]] || die 'Empty account UUID.'
# JSON is valid YAML and avoids interpolating YAML or shell fragments from user input.
SA_NAME="companion-bootstrap-$(date +%s)"
jq -n --arg id "$(cat "$BASE/account-id")" --arg omni "$OMNI_URL" --arg machine "https://$OMNI_HOST:19090" --arg sa "$SA_NAME" \
  --arg k8s "https://$OMNI_HOST:19100" --arg wg "$HOST_IP:51180" \
  --arg admin "$(jq -r '.users[] | select(.admin) | .email' "$COMPANION_DATA/state.json" | head -n1)" \
  '{account:{id:$id,name:"omni-companion"},services:{api:{endpoint:"0.0.0.0:19443",advertisedURL:$omni,certFile:"/certs/tls.crt",keyFile:"/certs/tls.key"},machineAPI:{endpoint:"0.0.0.0:19090",advertisedURL:$machine,certFile:"/certs/tls.crt",keyFile:"/certs/tls.key"},kubernetesProxy:{endpoint:"0.0.0.0:19100",advertisedURL:$k8s,certFile:"/certs/tls.crt",keyFile:"/certs/tls.key"},siderolink:{wireGuard:{endpoint:"0.0.0.0:51180",advertisedEndpoint:$wg},eventSinkPort:19091,logServerPort:19092,joinTokensMode:"strict"},metrics:{endpoint:"127.0.0.1:12122"},workloadProxy:{enabled:false},loadBalancer:{minPort:22000,maxPort:24000}},auth:{initialUsers:[$admin],initialServiceAccount:{enabled:true,name:$sa,role:"Admin",keyPath:"/data/bootstrap-sa",lifetime:"1h"}},storage:{default:{kind:"etcd",etcd:{embedded:true,embeddedDBPath:"/data/etcd",privateKeySource:"file:///keys/omni.asc"}},sqlite:{path:"/data/secondary-storage/sqlite.db"}}}' > "$BASE/config/omni.next.json"
# Keep the owner's prior acceptance on migrations. Never manufacture acceptance.
if [[ -f $BASE/config/omni.json ]] && jq -e '.eulaAccept.name and .eulaAccept.email' "$BASE/config/omni.json" >/dev/null; then
  jq --slurpfile old "$BASE/config/omni.json" '.eulaAccept=$old[0].eulaAccept' "$BASE/config/omni.next.json" > "$BASE/config/omni.accepted.json"
  mv "$BASE/config/omni.accepted.json" "$BASE/config/omni.next.json"
elif [[ -n $EULA_NAME && -n $EULA_EMAIL ]]; then
  jq --arg name "$EULA_NAME" --arg email "$EULA_EMAIL" '.eulaAccept={name:$name,email:$email}' "$BASE/config/omni.next.json" > "$BASE/config/omni.accepted.json"
  mv "$BASE/config/omni.accepted.json" "$BASE/config/omni.next.json"
fi
jq -n --arg issuer "$COMPANION_URL" --arg id "$(jq -r .client_id "$COMPANION_DATA/state.json")" \
  --arg secret "$(jq -r .client_secret "$COMPANION_DATA/state.json")" \
  '{auth:{auth0:{enabled:false},saml:{enabled:false},webauthn:{enabled:false},oidc:{enabled:true,providerURL:$issuer,clientID:$id,clientSecret:$secret,scopes:["openid","email","profile"]}},etcdBackup:{s3Enabled:true,localPath:null}}' > "$BASE/managed/companion.next.yaml"
jq -n --arg endpoint "$S3_URL" --arg access "$(jq -r .s3_access_key "$COMPANION_DATA/state.json")" --arg secret "$(jq -r .s3_secret_key "$COMPANION_DATA/state.json")" \
  '{metadata:{namespace:"default",type:"EtcdBackupS3Configs.omni.sidero.dev",id:"etcd-backup-s3-conf"},spec:{bucket:"omni",region:"us-east-1",endpoint:$endpoint,accesskeyid:$access,secretaccesskey:$secret,sessiontoken:""}}' > "$BASE/config/s3.json"
printf '%s\n' "$PROFILE" > "$BASE/pending-profile"
printf '{\n admin off\n auto_https disable_redirects\n}\nhttps://%s:18443 {\n tls /certs/tls.crt /certs/tls.key\n reverse_proxy 127.0.0.1:18480\n}\nhttps://%s:19444 {\n tls /certs/tls.crt /certs/tls.key\n reverse_proxy 127.0.0.1:19000 {\n  flush_interval -1\n }\n}\n' "$COMPANION_HOST" "$COMPANION_HOST" > "$BASE/proxy-config/Caddyfile.next"
if [[ $PHASE == prepare ]]; then
  printf 'Prepared %s profile. No application container has been changed.\nCompanion: %s\nOmni: %s\nS3: %s\n' "$PROFILE" "$COMPANION_URL" "$OMNI_URL" "$S3_URL"
  if [[ $PROFILE == lan ]]; then printf 'Install this public root on your clients first: %s/root-ca.crt\n' "$CERTS"; fi
  printf 'Review the prepared files and Omni EULA, then rerun with --phase apply. Keep the same --base across profile migrations.\n'
  exit 0
fi
if ! jq -e '.eulaAccept.name and .eulaAccept.email' "$BASE/config/omni.next.json" >/dev/null; then
  [[ -t 0 ]] || die 'Read https://siderolabs.com/eula/ and provide your own acceptance with --eula-name and --eula-email before applying.'
  printf 'Review https://siderolabs.com/eula/ and the Omni license before continuing.\n'
  read -r -p 'Do you accept the Omni EULA on behalf of this instance? Type ACCEPT to continue: ' agreement
  [[ $agreement == ACCEPT ]] || die 'No agreement accepted; application containers were not changed.'
  read -r -p 'Your full name for EULA acceptance: ' EULA_NAME
  read -r -p 'Your email for EULA acceptance: ' EULA_EMAIL
  [[ -n $EULA_NAME && $EULA_EMAIL == *@* ]] || die 'Name and email are required by Omni.'
  jq --arg name "$EULA_NAME" --arg email "$EULA_EMAIL" '.eulaAccept={name:$name,email:$email}' "$BASE/config/omni.next.json" > "$BASE/config/omni.accepted.json"
  mv "$BASE/config/omni.accepted.json" "$BASE/config/omni.next.json"
fi
for port in 18443 19443 19444 19090 19100 51180; do
  listeners=$(ss -H -lntup | awk -v port=":$port" '$5 ~ (port "$")')
  if [[ -n $listeners ]]; then
    owned=false
    for name in omni-companion talos-home-proxy; do
      pid=$(docker inspect -f '{{.State.Pid}}' "$name" 2>/dev/null || true)
      if [[ -n $pid && $pid != 0 ]] && grep -qF "pid=$pid," <<< "$listeners"; then owned=true; fi
    done
    [[ $owned == true ]] || die "Port $port is already in use by another service; inspect before continuing."
  fi
done
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cp "$COMPANION_DATA/state.json" "$BASE/rollback/companion-$stamp.json"
if [[ -f $BASE/config/omni.json ]]; then cp "$BASE/config/omni.json" "$BASE/rollback/omni-$stamp.json"; fi
if [[ -f $BASE/managed/companion.yaml ]]; then cp "$BASE/managed/companion.yaml" "$BASE/rollback/overlay-$stamp.yaml"; fi
mv "$BASE/pending-profile" "$BASE/profile"
mv "$BASE/proxy-config/Caddyfile.next" "$BASE/proxy-config/Caddyfile"
mv "$BASE/config/omni.next.json" "$BASE/config/omni.json"
mv "$BASE/managed/companion.next.yaml" "$BASE/managed/companion.yaml"
cp "$BASE/config/omni.json" "$BASE/managed/imported-primary.yaml"
chown 99:100 "$BASE/managed/companion.yaml" "$BASE/managed/imported-primary.yaml"
docker pull "$IMAGE"
docker pull ghcr.io/siderolabs/omni:v1.13.2
docker pull caddy:2
# Obtain the official image's public roots and append our LAN root for Omni's OIDC TLS.
temp_container=$(docker create ghcr.io/siderolabs/omni:v1.13.2)
docker cp "$temp_container:/etc/ssl/certs/ca-certificates.crt" "$CERTS/ca-bundle.pem"
docker rm "$temp_container" >/dev/null
if [[ $PROFILE == lan ]]; then cat "$CERTS/root-ca.crt" >> "$CERTS/ca-bundle.pem"; fi
docker stop talos-companion >/dev/null
jq --arg profile "$PROFILE" --arg companion "$COMPANION_URL" --arg omni "$OMNI_URL" --arg s3 "$S3_URL" \
  '.integration={profile:$profile,companion_url:$companion,omni_url:$omni,s3_endpoint:$s3} | .redirect_uri=($omni+"/oidc/consume")' "$COMPANION_DATA/state.json" > "$COMPANION_DATA/state.next.json"
chown 99:100 "$COMPANION_DATA/state.next.json"
mv "$COMPANION_DATA/state.next.json" "$COMPANION_DATA/state.json"
# Recreate only these named managed containers. Persistent volumes are never deleted.
for name in talos-companion omni-companion talos-home-proxy; do
  if docker container inspect "$name" >/dev/null 2>&1; then docker rm -f "$name" >/dev/null; fi
done
docker run -d --name talos-companion --restart unless-stopped --user 99:100 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -p 18480:8080 -p 19000:9000 -v "$COMPANION_DATA:/data" -v "$BASE/managed:/omni-managed" \
  -e "PUBLIC_URL=$COMPANION_URL" -l net.unraid.docker.managed=dockerman -l "net.unraid.docker.webui=$COMPANION_URL" "$IMAGE" >/dev/null
# The official Caddy binary carries cap_net_bind_service; keep that capability in
# the bounding set or Linux refuses exec even though our listeners use high ports.
docker run -d --name talos-home-proxy --restart unless-stopped --network host --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
  -v "$BASE/proxy-config/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$CERTS:/certs:ro" -v "$BASE/proxy-data:/data" caddy:2 >/dev/null
docker run -d --name omni-companion --restart unless-stopped --network host --cap-add NET_ADMIN --device /dev/net/tun --security-opt no-new-privileges:true \
  -v "$BASE/config:/config:ro" -v "$BASE/managed:/managed:ro" -v "$BASE/keys:/keys:ro" -v "$CERTS:/certs:ro" -v "$BASE/data:/data" \
  -e SSL_CERT_FILE=/certs/ca-bundle.pem -l net.unraid.docker.managed=dockerman -l "net.unraid.docker.webui=$OMNI_URL" \
  ghcr.io/siderolabs/omni:v1.13.2 --config-path=/config/omni.json --config-path=/managed/companion.yaml >/dev/null
printf 'Started managed containers. Preserve %s/account-id, keys, data, TLS and rollback files.\nCompanion: %s\nOmni: %s\n' "$BASE" "$COMPANION_URL" "$OMNI_URL"
ready=false
for _ in $(seq 1 90); do
  if [[ -s $BASE/data/bootstrap-sa ]] && curl --cacert "$CERTS/ca-bundle.pem" -fsS --max-time 3 "$OMNI_URL" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]] || die 'Omni did not become ready. Inspect its private container logs; original deployments are preserved.'
chmod 600 "$BASE/data/bootstrap-sa"
export OMNI_SERVICE_ACCOUNT_KEY="$(cat "$BASE/data/bootstrap-sa")"
export OMNI_ENDPOINT="$OMNI_URL"
docker exec -e OMNI_SERVICE_ACCOUNT_KEY -e OMNI_ENDPOINT omni-companion /omnictl/omnictl-linux-amd64 apply -f /config/s3.json > "$BASE/bootstrap-apply.log" 2>&1 || die 'S3 resource application failed; inspect the private bootstrap-apply.log.'
# Disable recreation before revoking the short-lived bootstrap administrator.
jq '.auth.initialServiceAccount.enabled=false' "$BASE/config/omni.json" > "$BASE/config/omni.final.json"
mv "$BASE/config/omni.final.json" "$BASE/config/omni.json"
docker exec -e OMNI_SERVICE_ACCOUNT_KEY -e OMNI_ENDPOINT omni-companion /omnictl/omnictl-linux-amd64 serviceaccount destroy "$SA_NAME" > "$BASE/bootstrap-revoke.log" 2>&1 || die 'Revoke the bootstrap account manually; its key expires in one hour.'
unset OMNI_SERVICE_ACCOUNT_KEY OMNI_ENDPOINT
cp "$BASE/config/omni.json" "$BASE/managed/imported-primary.yaml"
chown 99:100 "$BASE/managed/imported-primary.yaml"
docker restart omni-companion >/dev/null
printf 'S3 receiver configured using the official Omni client. Temporary bootstrap account revoked. Verify a real cluster backup after adding a node.\n'
printf 'This helper never starts/stops the old Omni or Omni-Dex containers.\n'
