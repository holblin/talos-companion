# Sidero Labs Omni on Unraid

This is an unofficial **new-installation** template, checked against Omni **v1.13.2**
on 2026-11-02. It pulls the official `ghcr.io/siderolabs/omni:v1.13.2` image.
It does not install or modify an existing Omni deployment. For an upgrade, preserve
your account UUID, databases and encryption keys and follow upstream migration guidance.
The template has been structurally validated; a live Omni deployment was not performed.

Omni is separately licensed by Sidero Labs. Read its [license](https://github.com/siderolabs/omni/blob/v1.13.2/LICENSE)
and [EULA](https://siderolabs.com/eula/). Complete acceptance yourself. This template
does not pre-accept terms or provide a commercial license.

## Prepare files

Use a dedicated appdata directory, on persistent storage with reliable fsync. Prefer
Unraid's appdata cache pool for database workloads; avoid remote SMB/NFS database storage.
The example uses `/mnt/user/appdata/omni-siderolabs`:

```text
omni-siderolabs/
  config/
    omni.yaml
    omni.asc
    tls/fullchain.pem
    tls/privkey.pem
  data/
    etcd/
    secondary-storage/
```

1. Create these directories. Keep configuration and private keys accessible only to the
   administrator/container process, for example root ownership, directories `0700` and
   private files `0600`. The template retains the official image's user; do not apply
   Companion's `99:100` ownership instructions to Omni without checking the image.
2. Copy `omni-config.example.yaml` to private `config/omni.yaml`. Replace all `REPLACE_`
   values, `example.com` addresses, and the documentation IP `192.0.2.10`.
3. Generate a unique account UUID with `uuidgen` and save it in `account.id` permanently.
4. Follow [upstream GPG encryption-key preparation](https://github.com/siderolabs/omni-docs/blob/main/content/docs/how-to-guides/self-hosted/how-to-deploy-omni-on-prem/index.md#create-etcd-encryption-key).
   Put the exported unencrypted ASCII-armored private encryption key in `config/omni.asc`.
   Store an offline copy separately. Do not put the key or real configuration in this repository.
5. Supply trusted TLS certificate files at the illustrated paths, covering your advertised
   Omni hostname. Keep renewed files under the mounted directory; a restart may be needed
   for reload. The example terminates TLS in Omni for API, machine API and Kubernetes proxy.
6. Review Omni's EULA and then supply your own `eulaAccept.name` and `eulaAccept.email`
   if you accept. They are intentionally commented out in the example; Omni requires
   acceptance before its first successful startup.

## Authentication and backups

Finish Companion setup first. Choose a stable HTTPS Companion issuer reachable from Omni
and browsers. In Companion > Identity, register the exact callback
`https://YOUR_OMNI_HOST/oidc/consume`, including any non-default public port.
Put Companion's issuer, client ID and client secret in your private Omni configuration.
Set `auth.initialUsers` to the administrator's exact Companion email. Additional accounts
still need authorization in Omni; automatic OIDC user creation is disabled in this example.
For the currently installed LAN-only Companion, plan HTTPS before exposing identity publicly.

`etcdBackup.s3Enabled` enables S3 cluster backups. After Omni starts, apply an
`EtcdBackupS3Configs.omni.sidero.dev` resource using the S3 endpoint and credentials from
Companion > Identity; the bucket is `omni`, region `us-east-1`. See the
[Companion integration guide](https://github.com/holblin/talos-companion/blob/main/docs/omni.md).
Do not add `localPath` while S3 backups are enabled.

Companion recovery bundles include the cluster snapshots it receives. They do not
automatically back up Omni's own database: follow the upstream database backup procedure
and separately protect Omni's UUID, GPG key, configuration and TLS material.

## Network and template installation

The template follows upstream's **host networking**, `NET_ADMIN` and `/dev/net/tun`
requirements for SideroLink. It leaves privileged mode off. Ensure `/dev/net/tun` exists
on Unraid. These permissions apply to Omni; Companion remains an unprivileged container.

The example config uses these host listeners; Docker port mappings do not remap them
in host mode. Resolve conflicts with any existing Omni or other containers before starting:

| Listener | Example | Reachability |
| --- | --- | --- |
| Web/API | TCP 8443, TLS | Browser and Omni clients; proxy public 443 to 8443 or advertise `:8443` |
| Machine API | TCP 8090, TLS | Talos nodes; gRPC/HTTP2 capable path |
| Kubernetes proxy | TCP 8100, TLS | Kubernetes clients |
| SideroLink WireGuard | UDP 50180 | Talos nodes, advertised using a literal reachable IP |
| Metrics | TCP 2122 | Loopback only |
| Event/log sinks | 8091 / 8092 | Internal SideroLink traffic; do not publicly forward |

Other Omni features may use additional ports. Embedded etcd remains in-process with no
external etcd listener in this example. Workload proxying is disabled until configured.
An HTTP-only proxy/tunnel is not a replacement for the WireGuard UDP path; configure
upstream's gRPC tunnel mode explicitly if your network requires it.

Copy `templates/omni.xml` to
`/boot/config/plugins/dockerMan/templates-user/my-omni-siderolabs.xml`. Select
**Docker > Add Container > omni-siderolabs**, check both host paths, and change its WebUI
to your actual HTTPS address. Start only after the prerequisites are ready. Check logs
for configuration errors, log in, provision a test node and verify cluster backup/recovery
before relying on the installation.

## Upstream references

- [Official v1.13.2 Compose deployment](https://github.com/siderolabs/omni/tree/v1.13.2/deploy/compose)
- [Pinned configuration schema](https://github.com/siderolabs/omni/blob/v1.13.2/internal/pkg/config/schema.json)
- [Omni releases and upgrade notes](https://github.com/siderolabs/omni/releases)
- [Omni documentation](https://docs.siderolabs.com/omni/overview/what-is-omni)

The MIT license here covers only these independently authored templates and guides.
It does not relicense Omni or Sidero Labs trademarks.
