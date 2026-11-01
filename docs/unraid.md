# Deploy on Unraid

Unraid uses Linux amd64, which is the image’s build target. Build the image with Docker Compose on Unraid, or build on another Linux amd64 Docker host and transfer it with `docker save` / `docker load`. No container image has been published to a registry by this project.

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

Set a stable `PUBLIC_URL`, a random `SETUP_TOKEN` (24+ characters), and a separate `BACKUP_PASSPHRASE` (16+ characters). Store the passphrase outside Unraid. Real `.env` files, keys, and recovery archives must not be committed to Git.

## NFS and SMB

Mount NFS/SMB **on the Unraid host**, for example using Unassigned Devices or an administrator-managed mount. Pass the mounted directory into the container as `/destinations/network`. Set `MOUNTED_BACKUP_DIR=/destinations/network`.

Companion needs only filesystem access. It does not need SMB/NFS packages, share credentials, privileged mode, host networking, or mount capabilities inside its scratch image. The share credentials remain managed by Unraid.

The destination root must exist. The app and Compose configuration deliberately avoid creating it if it is absent. A failed transfer retains the local backup and reports an error. An existing directory alone does not prove a network filesystem is mounted: configure Unraid so the container stops or fails closed when the share disappears. Avoid an ordinary empty directory at the same path silently substituting for your network mount.

Use `SCHEDULE_DESTINATION=mounted` to copy scheduled recovery files to that share. The local recovery file is always written first. Keep an eye on storage usage: automatic retention is not implemented.

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
