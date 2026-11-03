# Docker Hub and Unraid distribution

Application source and the independently authored template bundle are public under MIT.
Omni itself retains its own upstream license and EULA. Publication followed a full-history,
tracked-file and Actions-log credential audit; see [the audit record](security-audit.md).

## Current state

- Current public image: [`holblin/talos-companion:0.1.1`](https://hub.docker.com/r/holblin/talos-companion/tags), also tagged `latest` and `sha-7d7f21cf93e935a16fa66279b46173856d45495a`.
- Its digest is `sha256:090aab703e25aaa3ee4c5695103644d65d827a9199f5ee86232b9d4cbc7eb7a0`. All three current tags resolve to that image. Registry verification confirms Linux amd64, one filesystem layer, UID `99:100`, and the Rust entrypoint. The compressed layer is 7,646,178 bytes.
- [The 0.1.1 publishing run](https://github.com/holblin/talos-companion/actions/runs/41390853502) passed strict application checks, the 320 MiB streaming recovery test, automatic startup-secret permission checks, and container/template checks before upload. Docker Hub credentials remain an encrypted GitHub Actions secret.
- Version 0.1.0 remains available at digest `sha256:c7d653fbef035575e11a7425a26fb2ce32d270b04a63e90d891d665a57b8fec8`.
- `.github/workflows/release.yml` can build, test, and package the image without uploading it.
- Publishing is an explicit manual workflow choice, off by default. Ordinary commits never push images.
- `scripts/prepare-unraid.ps1` generates a separate template-only repository in `dist/community-apps`.
- Public templates: [holblin/talos-companion-unraid](https://github.com/holblin/talos-companion-unraid), with Companion and Omni XML, an Omni example configuration and installation guides.
- Future registry uploads use the saved Docker Hub secret. Public repository availability does not automatically add templates to the Community Apps catalog; its submission/review is separate.

## One-time Docker Hub setup

1. Sign in to [Docker Hub](https://hub.docker.com/) as `holblin` and create repository
   `talos-companion`. Choose its visibility explicitly before uploading anything.
   A private repository works for your own authenticated Unraid server. A future
   Community Apps listing should use an image users can pull publicly.
2. Create a Docker Hub personal access token with read/write image permissions and an expiration.
   Do not grant delete permission. Do not paste it into chat or commit it to this repository.
3. Save it as repository Actions secret `DOCKERHUB_TOKEN` at
   [GitHub Actions secrets](https://github.com/holblin/talos-companion/settings/secrets/actions).
   The repository Actions variable `DOCKERHUB_USERNAME` is `holblin`.
4. Optionally paste `deploy/dockerhub-description.md` into the Docker Hub repository description.

Docker's [GitHub Actions guide](https://docs.docker.com/build/ci/github-actions/)
documents the token and username configuration. Configure image visibility on Docker Hub:
an image push must not be used to guess or change the namespace's default privacy setting.

## Build and publish

Open [Prepare or publish Docker Hub image](https://github.com/holblin/talos-companion/actions/workflows/release.yml)
and choose **Run workflow**. Use the desired source branch/ref and a version such as
`0.1.0` or `0.1.0-beta.1`.

- Leave **publish** unchecked to test and download build artifacts without uploading an image.
- Check **publish** only after the Docker Hub repository and Actions secret exist.

Both modes run frontend formatting, strict type-aware linting, TypeScript checking,
Rust formatting, Clippy, unit tests, HTTP/S3 recovery tests, and the 320 MiB streaming test.
The container build verifies exactly one filesystem layer and confirms that the layer
contains only the static Rust binary and compiled frontend. It also runs a container smoke test.

The publishing job loads the same verified image archive, rather than rebuilding it.
Published tags are the version and `sha-<full Git commit>`. Stable versions also update
`latest`; prereleases do not. Do not reuse released version numbers. Linux amd64 is
the supported image architecture. Image archives expire from GitHub artifacts after one day;
template bundles expire after 30 days. Keep needed release artifacts separately.

After an upload, verify the image from a clean host:

```sh
docker pull holblin/talos-companion:0.1.0
docker image inspect holblin/talos-companion:0.1.0 --format '{{len .RootFS.Layers}}'
# Must print 1
```

`deploy/compose.hub.yaml` runs the registry image without source access or a local build.
Use it only after the selected image tag exists. Retain `.env` and persistent appdata privately.

## Prepare the Unraid template repository

The release workflow creates artifact `unraid-template-repository`. To generate
the same files locally using PowerShell 7:

```powershell
./scripts/prepare-unraid.ps1 -DockerHubNamespace holblin `
  -TemplateRepository holblin/talos-companion-unraid `
  -OutputDirectory dist/community-apps
```

The output contains exactly:

```text
README.md
LICENSE
ca_profile.xml
icon.svg
templates/talos-companion.xml
templates/omni.xml
omni-config.example.yaml
omni-install.md
```

The application and independently authored template files use MIT. Omni's own upstream
license and EULA remain separate. Public raw XML URLs resolve from the template repository.

For a private manual installation, after the image exists, copy the generated XML to
`/boot/config/plugins/dockerMan/templates-user/my-talos-companion.xml` on your Unraid server,
then open **Docker → Add Container** and choose the template. If the image is private,
authenticate Docker on that server before pulling it. No catalog submission is needed
for this manual installation.

## Community Apps listing — deferred

The [official submission requirements](https://ca.unraid.net/submit/help) call for a public
active repository, an OSI-approved license, `ca_profile.xml`, valid templates, and a Validate/Scan pass.
The generated bundle supplies the template files separately from the application source.

Public distribution and catalog review are separate:

1. Publish an image that Unraid users can pull, and test installation and recovery on an actual Unraid server.
2. Maintain public repository `holblin/talos-companion-unraid`, with Issues enabled.
   Upload only the eight generated template files. Never upload the application checkout,
   `.env`, local test data, keys, or backup files.
3. Confirm the icon, `TemplateURL`, support link, and image URL resolve publicly.
4. Sign in at [Community Apps submissions](https://ca.unraid.net/submit), then Validate
   and Scan the template repository. Review and submit the listing through your Unraid account.
   Submission includes agreement to Unraid's terms, so the account owner should complete that final step.
5. Address moderator feedback and keep the template and image tags updated together.

Companion 0.1.1 has been installed and reported healthy on an Unraid server. The Omni
template is validated against upstream configuration but has not been live-deployed.
Community Apps catalog acceptance has not been requested or claimed.
