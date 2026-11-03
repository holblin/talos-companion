# Deploy on Unraid

The Linux amd64 image is published on [Docker Hub](https://hub.docker.com/r/holblin/talos-companion). Use `holblin/talos-companion:0.1.1` for a pinned version, or `holblin/talos-companion:latest` for the current stable release. `deploy/compose.hub.yaml` runs the registry image without a local build. Source builds using the main `compose.yaml` remain available.

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
| `/destinations/network` | Your existing mounted backup share (read/write) |
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

## NFS and SMB

Mount NFS/SMB **on the Unraid host**, for example using Unassigned Devices or an administrator-managed mount. Pass the mounted directory into the container as `/destinations/network`. Set `MOUNTED_BACKUP_DIR=/destinations/network`.

Companion needs only filesystem access. It does not need SMB/NFS packages, share credentials, privileged mode, host networking, or mount capabilities inside its scratch image. The share credentials remain managed by Unraid.

The destination root must exist. The app and Compose configuration deliberately avoid creating it if it is absent. A failed transfer retains the local backup and reports an error. An existing directory alone does not prove a network filesystem is mounted: configure Unraid so the container stops or fails closed when the share disappears. Avoid an ordinary empty directory at the same path silently substituting for your network mount.

Choose **Mounted NFS / SMB** in **Settings → Backup settings** for scheduled copies. The same page controls recovery retention (default seven files per destination) and Omni snapshot retention (default 30 per cluster); zero disables pruning. Changes persist in `/data/config.json` and apply immediately. Pruning happens only after a successful backup. Use a dedicated destination directory.

Large backups stream through bounded buffers; they have no fixed byte-size cap. Restore needs temporary disk space for both the encrypted upload and extracted files. Configure proxy upload limits/timeouts accordingly. S3 operations pause while a consistent source snapshot is archived, so Omni's timeouts must allow for the time spent reading and encrypting the retained data.

## First launch and restore

Create an administrator, or choose Restore on the initial screen. To restore, supply the `.tcb` file and the passphrase used when it was created. You can replace the first administrator’s credentials while keeping other accounts and identity keys.

Restore requires an uninitialized data directory. Keep the original data directory intact until recovery has been checked on a fresh instance. The container environment supplies the new public URL, setup token, and passphrase for future backups.

## Verify the one-layer image

```sh
docker image inspect talos-companion:local --format '{{len .RootFS.Layers}}'
# 1
docker history talos-companion:local
```

Only the `COPY` instruction changes the final root filesystem. The final image has no base OS layers. `USER`, ports, volume declarations, environment variables, entrypoint, and healthcheck are image configuration, not extra filesystem layers. The `/data` volume and Docker’s injected `/etc/hosts`, `/etc/hostname`, and resolver files are runtime mounts, not application image contents.

The healthcheck is implemented in the Rust binary, so it requires no shell or curl. The running image is read-only except for `/data` and the explicitly mounted destination.
