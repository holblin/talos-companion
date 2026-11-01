# Talos Companion

A small, self-hosted Rust + React application for Talos Omni identity and recovery. Deploy it on Unraid with one container. The final Docker image is built **from scratch, with exactly one filesystem layer containing only a static Rust executable and the compiled frontend**.

## What it does

- First launch: create an administrator or restore an encrypted recovery file.
- Restore: optionally replace the first administrator’s name, email, and password while preserving their OIDC subject ID and all other accounts.
- Identity: a dedicated OIDC provider for Omni, with discovery, RS256/JWKS, authorization codes, S256 PKCE, and userinfo.
- Accounts: administrators can create/remove accounts; members can change their own password and sign in to Omni.
- Receiver: authenticated S3 API, including multipart uploads, backed by the Rust `s3s`/`s3s-fs` libraries. Omni’s bucket is created automatically.
- Recovery: encrypted snapshots include accounts, password hashes, signing keys, client credentials, Google tokens, uploaded Omni recovery material, and all received S3 data and metadata.
- Destinations: persistent local storage, authenticated browser download, Google Drive, and host-mounted NFS/SMB shares. Every remote transfer retains a local copy.
- Scheduling: daily by default, configurable with environment variables.

This is an initial implementation. The S3 backend uses the upstream experimental filesystem provider. Automated tests exercise signed S3 requests and multipart uploads; validate against your own Omni deployment before depending on it for recovery. Upload Omni encryption keys/configuration through the recovery-material vault to include them in snapshots. Companion does not automatically snapshot Omni’s own database or collect its encryption keys. See [Omni setup and recovery](docs/omni.md).

## Run on Unraid

1. Clone this private repository onto your build host.
2. Copy `.env.example` to `.env`, set your public URL, and replace both secret placeholders with independent random values. Save the backup passphrase separately from this server.
3. Pre-create the data and destination directories with ownership matching `PUID:PGID` (default `99:100`). For a local trial on Linux:

   ```sh
   mkdir -p data network-backups
   sudo chown 99:100 data network-backups
   chmod 700 data network-backups
   ```

4. Run `docker compose up -d --build` (or `mise run up`).
5. Open the configured public URL. Enter the setup token, then create an administrator or restore a `.tcb` file.

The image runs as an unprivileged numeric user with a read-only root filesystem. `/data` must be writable. The container needs no shell, Node, rclone, dynamically linked libraries, or CA files; the Rust HTTPS client includes public trust roots.

See [Unraid instructions](docs/unraid.md), [Omni configuration](docs/omni.md), and [Google Drive setup](docs/google-drive.md).

## Development with mise

Install [mise](https://mise.jdx.dev/), then:

```sh
mise trust
mise install
mise run web:install
```

Tool versions live in `mise.toml`; download metadata lives in `mise.lock`. Rust and npm dependencies have their own committed lockfiles. The frontend pins React 19.3.1, Vite 8.3.5, and TypeScript 7.0.2, the stable registry versions checked when this project was created.

Set `SETUP_TOKEN` (24+ characters) and `BACKUP_PASSPHRASE` (16+ characters) in your shell. The server deliberately refuses to start without them. `.env` is used by Docker Compose; it is not automatically read by the Rust executable.

```sh
# Terminal 1: backend. This task sets PUBLIC_URL=http://localhost:5173.
mise run dev
# Terminal 2: Vite, with API/OIDC proxies to the backend.
mise run web:dev
```

Open `http://localhost:5173`. Native Windows Rust builds require Visual Studio C++ build tools. Docker builds target Linux amd64 with musl, appropriate for Unraid.

```sh
mise run web:build  # TypeScript validation + production frontend
mise run check      # Rust formatting, Clippy, unit tests
mise run test       # Unit tests + full HTTP/S3 recovery integration test
mise run build      # Frontend + release executable
mise run docker:build
```

CI uses mise for the same checks and verifies the built image has exactly one layer. It also checks the scratch container can serve the frontend and run its own health probe.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8080` | Exact browser origin and OIDC issuer; use HTTPS in deployment. |
| `SETUP_TOKEN` | required | Protects first-time setup and restore. Minimum 24 characters. |
| `BACKUP_PASSPHRASE` | required | Encrypts newly created backups. Minimum 16 characters. Keep it offline. |
| `DATA_DIR` | `data` (`/data` in Docker) | State, S3 receiver files, and recovery files. |
| `WEB_DIR` | `web/dist` (`/web` in Docker) | Compiled frontend. |
| `LISTEN_ADDR` | `0.0.0.0:8080` | Web/API listener. |
| `S3_LISTEN_ADDR` | `0.0.0.0:9000` | Authenticated S3 listener, starts after setup. |
| `MOUNTED_BACKUP_DIR` | unset | Existing directory for NFS/SMB/local copies. |
| `BACKUP_INTERVAL_SECONDS` | `86400` | Schedule interval; minimum 60 seconds. |
| `SCHEDULE_DESTINATION` | `local` | `local`, `mounted`, or `drive`. |

## Recovery and limits

Recovery files use a versioned binary envelope (`TCBACKUP` + version 1), a random 16-byte salt, a random 12-byte nonce, Argon2id v19 (19 MiB, 2 iterations, parallelism 1, 32-byte key), and ChaCha20-Poly1305 authenticated encryption. The encrypted payload is a tar archive. Each snapshot gets independent salt and nonce values.

Snapshots currently have a **256 MiB uncompressed archive limit** and are processed in memory. Oversized snapshots fail without producing a partial backup. Individual received S3 objects can be larger, but will then exceed the recovery snapshot limit. This is suitable for initial testing and small installations, not large cluster snapshots. Recovery files are not automatically pruned; manage retention on your storage. Failed remote transfers leave the local file available and are reported to the caller and logs.

Restore is permitted only on an uninitialized instance. The entire archive is decrypted and validated in a staging directory before replacement. Absolute paths, traversal, links, special files, duplicate paths, unsupported versions, and malformed identity state are rejected. Sessions and pending authorization codes live only in memory and are never backed up. New `PUBLIC_URL`, setup token, and backup passphrase values come from the replacement container environment.

Keep `/data` private: active credentials and signing keys are stored there; encrypted export protects the recovery file, not the live data directory. Only trusted administrators should have access to backup/identity APIs. TLS belongs at your existing reverse proxy. The app has no public registration or email verification service: an administrator adding an account asserts ownership of its email address. Omni roles and ACLs remain managed in Omni. Password changes and removals revoke companion sessions; already issued tokens remain valid until expiry (five minutes), and Omni may retain its own sessions.
