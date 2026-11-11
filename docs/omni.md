# Connect Talos Omni

## Bootstrap a new instance offline

Use **Omni configuration → Set up a new Omni instance** before Omni's first start.
Only Companion needs to be configured with its stable HTTPS issuer. Enter planned Omni
addresses, the initial administrator email, WireGuard IP, ports, TLS/key paths under
read-only `/config` and database paths under writable `/data`. Generate and download
`omni.yaml` without contacting Omni. Companion registers the matching OIDC callback,
uses its actual client credentials, and persists one account UUID across edits/downloads.

Downloads are administrator-only and contain the OIDC client secret. Keep them private.
Prepare certificates and `omni.asc`, explicitly accept Omni's EULA yourself if you agree,
and mount/start the supported image. See the [Unraid installation guide](../deploy/unraid/omni-install.md)
for preparation and mount details. Generated configuration has no active EULA acceptance.

**Configuration generated** and **Omni connected** are separate states. Run connection
validation after startup; the check establishes HTTPS reachability from Companion only.
Verify real sign-in, node connections and backups separately. Enabling S3 mode in the YAML
still requires applying Omni's backup destination resource after startup, as described below.

For an existing installation, choose **Connect an existing Omni instance**, import the
primary YAML and review changes before downloading the updated full file. The scoped
update preserves its account UUID, encryption references, storage paths, initial users and
unrelated settings. Keep the original and inspect CLI/later-file overrides before applying.


## OIDC login

1. Set Companion’s `PUBLIC_URL` to its stable HTTPS origin, reachable from Omni and from your browser. Put your existing reverse proxy in front of web port 8080. Preserve the Host header; the issuer is taken from `PUBLIC_URL`, never from forwarded request headers.
2. In Companion → Identity, register Omni’s **exact** OIDC callback URL. Current Omni implementations commonly use `https://omni.example.com/oidc/consume`; verify your Omni version’s configuration. Redirect matching is exact.
3. Use the issuer, client ID, and client secret shown in Companion. An Omni configuration excerpt:

   ```yaml
   auth:
     oidc:
       enabled: true
       providerURL: https://companion.example.com
       clientID: omni
       clientSecret: REPLACE_WITH_COMPANION_CLIENT_SECRET
       scopes:
         - openid
         - email
         - profile
   ```

   The equivalent flags are `--auth-oidc-enabled`, `--auth-oidc-provider-url`, `--auth-oidc-client-id`, `--auth-oidc-client-secret`, and `--auth-oidc-scopes`. Check your Omni release for exact CLI syntax. Recent Omni versions also accept `OMNI_AUTH_OIDC_CLIENT_SECRET`.

4. Add accounts in Companion. Configure the appropriate users, initial administrators, roles, and access policies **in Omni**. A Companion administrator is not automatically an Omni administrator.

Companion supports a single confidential OIDC client with authorization-code grants, optional S256 PKCE, 60-second single-use authorization codes, and five-minute tokens. It does not implement refresh tokens, device authorization, dynamic client registration, or federated logout. Companion account emails are trusted assertions by your local administrator; there is no email verification service.

## Receive cluster backups

Enable S3 etcd backups when starting Omni. The current Omni configuration has `etcdBackup.s3Enabled: true` (CLI: `--etcd-backup-s3`). Local and S3 modes are mutually exclusive.

After Companion’s initial account setup, its S3 listener starts on port 9000 and creates the `omni` bucket. It supports path-style S3 requests with AWS signatures. Apply this resource through `omnictl`, replacing endpoint and credentials with the values from Companion → Identity:

```yaml
metadata:
  namespace: default
  type: EtcdBackupS3Configs.omni.sidero.dev
  id: etcd-backup-s3-conf
spec:
  bucket: omni
  region: us-east-1
  endpoint: https://companion-s3.example.com
  accesskeyid: REPLACE_WITH_ACCESS_KEY
  secretaccesskey: REPLACE_WITH_SECRET_KEY
  sessiontoken: ""
```

```sh
omnictl apply -f etcd-backup-s3-conf.yaml
omnictl get etcdbackupoverallstatus
```

Omni validates the target by listing its bucket. The S3 endpoint is separate from the web port. Use a trusted reverse proxy for HTTPS; do not expose unauthenticated HTTP over an untrusted network. Ensure the S3 proxy supports large/streaming uploads and preserves signed request headers, paths, and query parameters.

Use Omni’s UI or an `EtcdManualBackups.omni.sidero.dev` resource to trigger a cluster backup, and configure per-cluster automatic backups in Omni. Companion’s own schedule exports recovery bundles of data it has already received; it does not trigger Omni snapshots.

## A complete disaster-recovery plan

There are three different recovery concerns:

1. **Companion identity:** local accounts, Argon2 password hashes, RSA signing key, OIDC client secret, Google tokens, and receiver credentials. These are included in every Companion recovery file.
2. **Omni-managed cluster etcd:** objects written by Omni to the S3 receiver. These objects and the receiver’s filesystem metadata are included in recovery files. Restore the Companion file first, reconfigure Omni to use the restored S3 endpoint if its address changed, then follow Omni’s cluster-etcd recovery procedure. Companion does not directly apply etcd snapshots to Talos machines.
3. **Omni’s own database and encryption material:** back up the Omni database and its GPG/KMS configuration using the official Omni procedure. Receiving a Kubernetes etcd backup does not back up Omni’s own database. Upload your Omni encryption keys, configuration, or relevant external secrets through Companion → Backups → Omni credentials and recovery material (16 MiB per file). They are included in subsequent encrypted recovery files and downloadable by administrators after restore. Preserve a separate offline copy as well.

Restoring Companion can replace the first administrator’s credentials without changing their subject ID, so existing Omni identity mapping can remain valid. If you change their email, check Omni’s user mappings/ACLs. If you change Companion’s public origin, update Omni’s provider URL as well.

## Official references

- [Omni OIDC configuration schema](https://github.com/siderolabs/omni/blob/main/internal/pkg/config/schema.json)
- [Create etcd backups](https://docs.siderolabs.com/omni/cluster-management/etcd-backups)
- [Omni self-hosting and database recovery](https://docs.siderolabs.com/omni/overview/what-is-omni)
- [S3 implementation used by Companion](https://github.com/Nugine/s3s)

These interfaces were checked on November 1, 2026. End-to-end testing against your actual Omni release remains necessary.
