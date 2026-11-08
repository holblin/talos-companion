# Deploy on Unraid

The Linux amd64 image is published on [Docker Hub](https://hub.docker.com/r/holblin/talos-companion). Use `holblin/talos-companion:0.3.9` for a pinned version, or `holblin/talos-companion:latest` for the current stable release. `deploy/compose.hub.yaml` runs the registry image without a local build. Source builds using the main `compose.yaml` remain available.

The repository includes a build/publish workflow and a template-only bundle generator. Public templates for Companion and Omni are available in [talos-companion-unraid](https://github.com/holblin/talos-companion-unraid). See [publishing instructions](publishing.md) for registry-only Compose installation and Community Apps catalog review, which is separate from public template availability.

## Omni template

Use the separate [Omni installation guide](../deploy/unraid/omni-install.md) and
[Omni template](../deploy/unraid/omni.xml) for a new Omni deployment. It pins the official
Omni v1.13.2 image and uses private file-based configuration. It does not change an
existing Omni container. Omni has separate licensing, EULA, TLS and networking prerequisites.

## Persistent paths and ports

| Container path/port | Unraid mapping |
| --- | --- |
| `/data` | `/mnt/user/appdata/talos-companion` (read/write) |
| `/data/backups` | Optional host-mounted backup directory (read/write), used by Local storage |
| `8080/tcp` | Web/API/OIDC, typically behind your HTTPS proxy |
| `9000/tcp` | S3 receiver, reachable from Omni |

Use the included `compose.yaml`, or create a Docker template with equivalent ports, paths, and environment variables. An example XML template is in `deploy/unraid/talos-companion.xml`; it assumes you have built and tagged `talos-companion:local` on that host.

Create the appdata directory before starting the container:

```sh
mkdir -p /mnt/user/appdata/talos-companion
chown 99:100 /mnt/user/appdata/talos-companion
chmod 700 /mnt/user/appdata/talos-companion
```

Set a stable `PUBLIC_URL`. Leave `SETUP_TOKEN` and `BACKUP_PASSPHRASE` empty to generate persistent private secrets, or provide explicit overrides of 24+ and 16+ characters respectively. Find the generated setup token in first-start container logs or the private appdata `setup-token` file. At Review, save the shown backup passphrase outside Unraid and re-enter it after checking the saved box. The `backup-passphrase` file is also private persistent appdata. Real `.env` files, generated secrets, keys, and recovery archives must not be committed to Git.

## Cloudflare hostname changes

Saving a Companion Cloudflare address updates the tunnel and DNS routes, then
verifies HTTPS, this installation's identity, OpenID discovery, and signing keys.
If normal DNS access fails, Companion also checks using Cloudflare's public DNS
over HTTPS service. Certificate and hostname validation remain enabled.

If only that check succeeds, the address is saved as **Cloudflare verified · local
DNS updating**. Local DNS caches may still contain an older wildcard or negative
answer. Use **Check Cloudflare** after the cache refreshes to clear this status.
Omni issuer activation still requires verification through normal DNS. Local HTTPS
and Tailscale do not use the public DNS fallback.

## NFS and SMB

Open **Backups → Set up NFS / SMB** to connect directly to a remote server. Choose SMB and enter the hostname, share name, directory, username, and password, or choose NFSv3 and enter the hostname, export path, directory, and numeric UID/GID. The directory must already exist. NFS exports must allow the container's source IP and connections from unprivileged ports. No Docker mount, privileged mode, or additional container packages are required.

**Check access and save** creates, reads, and removes a temporary file before storing the destination. Credentials are stored privately with the application state and included in encrypted recovery files; the API never returns the SMB password. A blank password preserves the existing password only for the same server, share, and username.

Choose **Remote NFS / SMB** in **Backup settings** for scheduled copies, or **Back up to share** for an immediate backup. Uploads stream to a temporary remote file and are renamed after completion. Remote retention runs only after a successful transfer; failures preserve the local recovery file and report a warning. Use a dedicated remote directory for this instance.

If you prefer managing NFS/SMB mounts on the host, map that folder to **/data/backups** and select **Local storage**. Docker mounts are a local filesystem deployment choice and are not part of the NFS/SMB setup flow. The legacy MOUNTED_BACKUP_DIR destination remains supported for existing configurations.

## First launch and restore

Create an administrator, or choose Restore on the initial screen. To restore, supply the `.tcb` file and the passphrase used when it was created. You can replace the first administrator’s credentials while keeping other accounts and identity keys.

Restore requires an uninitialized data directory. Keep the original data directory intact until recovery has been checked on a fresh instance. The container environment supplies the new public URL, setup token, and passphrase for future backups.

## Verify the image layers

```sh
docker image inspect talos-companion:local --format '{{len .RootFS.Layers}}'
# 2
docker history talos-companion:local
```

Two `COPY` instructions create the final filesystem: certificates and selected connectors, followed by the app and frontend. The final image has no base OS layers. The default includes both Cloudflare Tunnel and the Tailscale daemon; `-cloudflare`, `-tailscale`, and `-minimal` tag suffixes select smaller variants after publication. `USER`, ports, volume declarations, environment variables, entrypoint, and healthcheck are image configuration, not extra filesystem layers. The `/data` volume and Docker’s injected `/etc/hosts`, `/etc/hostname`, and resolver files are runtime mounts, not application image contents.

The healthcheck is implemented in the Rust binary, so it requires no shell or curl. The running image is read-only except for `/data` and the explicitly mounted destination.
