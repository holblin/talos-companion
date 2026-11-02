# Talos Companion

An independent, self-hosted identity and recovery companion for Talos Omni.
Rust backend, React frontend, Linux amd64. The image contains one filesystem layer:
a static Rust executable and compiled frontend files, with no shell or base OS.

- Guided first-time account creation or encrypted recovery with optional administrator credential replacement.
- OpenID Connect sign-in provider and account management.
- Authenticated S3 receiver for Omni backups, plus a credential and recovery-material vault.
- Encrypted recovery files, configurable scheduling and retention, local storage, browser downloads,
  Google Drive, and host-mounted NFS/SMB destinations.
- Unprivileged UID 99:100, read-only root filesystem, no privileged mode or mount capabilities.

Map persistent storage to `/data` with ownership `99:100`. Expose web port `8080` through
your HTTPS reverse proxy, and make S3 port `9000` reachable from Omni.
Set `PUBLIC_URL` to the exact browser origin, `SETUP_TOKEN` to 24+ random characters,
and `BACKUP_PASSPHRASE` to a separate 16+ character secret stored outside this server.
The first launch wizard guides account creation or restore. Backup policies are managed
in Settings and saved in `/data/config.json`.

For NFS/SMB, mount the share on the host and bind it into the container, then set
`MOUNTED_BACKUP_DIR` to the container path. The container does not mount shares itself.

Upload Omni recovery keys/configuration explicitly. This application does not automatically
collect Omni's encryption keys or snapshot Omni's own database. Configure Omni to send its
supported S3 backups and verify recovery before depending on the companion.

Version and `sha-<commit>` tags identify published builds; `latest` tracks stable releases.
Use a pinned version or digest for controlled upgrades. Back up appdata before upgrading.

This is not an official Sidero Labs product. The application source is maintained privately;
availability of the image does not imply an open-source application license.
