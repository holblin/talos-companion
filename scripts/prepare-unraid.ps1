[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9_-]{2,29}$')][string]$DockerHubNamespace,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$TemplateRepository,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$allowedPaths = @('README.md', 'LICENSE', 'ca_profile.xml', 'icon.svg', 'templates/talos-companion.xml')
# Refuse a checkout or contaminated bundle rather than including unrelated files in an artifact.
if (Test-Path -LiteralPath $outputPath) {
    foreach ($file in Get-ChildItem -LiteralPath $outputPath -Recurse -File -Force) {
        $relative = [System.IO.Path]::GetRelativePath($outputPath, $file.FullName).Replace('\', '/')
        if ($relative -notin $allowedPaths) { throw "Unexpected file in bundle destination: $relative" }
    }
}
# Never clean a directory. This generator writes only the five listed files.
$templatePath = Join-Path $outputPath 'templates'
New-Item -ItemType Directory -Force -Path $templatePath | Out-Null
$publicBase = "https://github.com/$TemplateRepository"
$rawBase = "https://raw.githubusercontent.com/$TemplateRepository/main"
$image = "$DockerHubNamespace/talos-companion"
[xml]$template = Get-Content -LiteralPath (Join-Path $projectRoot 'deploy/unraid/talos-companion.xml') -Raw
$template.Container.Repository = "${image}:latest"
$template.Container.Registry = "https://hub.docker.com/r/$image"
$template.Container.Support = "$publicBase/issues"
$template.Container.Project = "$publicBase#talos-companion"
$template.Container.Overview = 'Identity, accounts, and encrypted recovery for Talos Omni. Guided first launch supports a new administrator or recovery with optional credential replacement. Includes an S3 receiver, credential vault, backup scheduling, browser downloads, Google Drive, and host-mounted NFS/SMB destinations. Runs without privileged mode as UID 99 with a read-only root filesystem. Pre-create appdata with ownership 99:100 and keep the backup passphrase separately. This is an independent companion, not an official Sidero Labs product.'
$template.Container.Category = 'Tools:Utilities'
foreach ($entry in @{
    TemplateURL = "$rawBase/templates/talos-companion.xml"
    Icon = "$rawBase/icon.svg"
}.GetEnumerator()) {
    $node = $template.CreateElement($entry.Key)
    $node.InnerText = $entry.Value
    [void]$template.Container.AppendChild($node)
}
# The network share is optional. Enable this variable only after mapping a real host mount.
$mountedSetting = $template.Container.Config | Where-Object Target -eq 'MOUNTED_BACKUP_DIR'
$mountedSetting.Default = ''
$mountedSetting.InnerText = ''
$template.Save((Join-Path $templatePath 'talos-companion.xml'))
$profile = [xml]'<CommunityApplications><Profile/><Icon/><WebPage/></CommunityApplications>'
$profile.CommunityApplications.Profile = 'Talos Companion: self-hosted identity, account management, and encrypted recovery for Talos Omni. This repository distributes installation templates and documentation only. The application source is maintained separately. Report installation and application problems through this repository''s issue tracker.'
$profile.CommunityApplications.Icon = "$rawBase/icon.svg"
$profile.CommunityApplications.WebPage = $publicBase
$profile.Save((Join-Path $outputPath 'ca_profile.xml'))
Copy-Item -LiteralPath (Join-Path $projectRoot 'deploy/unraid/icon.svg') -Destination (Join-Path $outputPath 'icon.svg')
$license = @'
MIT License

Copyright (c) 2026 holblin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'@
Set-Content -LiteralPath (Join-Path $outputPath 'LICENSE') -Value $license -Encoding utf8NoBOM
$readme = @"
# Talos Companion

Installation templates for the independent Talos Omni identity and recovery companion.
This repository contains no Rust/React application source, credentials, or user backups.
The MIT license applies only to the template, icon, and documentation in this repository.
It does not grant rights to the separately distributed application image or its source.

## Image

Docker Hub: https://hub.docker.com/r/$image

Image: ``${image}:latest``. Linux amd64 only. The image has exactly one filesystem
layer containing a static Rust binary and compiled frontend files.
Version and ``sha-<commit>`` tags are available for published versions.

## Install on Unraid

1. Create ``/mnt/user/appdata/talos-companion`` with ownership ``99:100`` and mode ``700``.
2. Install this template through Community Apps after the listing is approved, or copy
   ``templates/talos-companion.xml`` to
   ``/boot/config/plugins/dockerMan/templates-user/my-talos-companion.xml`` on your server.
   Then open Docker > Add Container and choose talos-companion.
3. Set PUBLIC_URL to the exact address you will use, including scheme and port.
   Use HTTPS at your reverse proxy for deployment beyond a trusted local network.
4. Leave secret overrides empty to generate private persistent secrets automatically,
   or supply your own SETUP_TOKEN (24+ characters) and BACKUP_PASSPHRASE (16+ characters).
   Find the generated setup token in first-start container logs. At Review, save the shown
   backup passphrase outside this server, check the saved box, and re-enter it to confirm.
5. Start the container and open its WebUI. The wizard guides account creation or restore,
   backup scheduling, retention, and connection preparation. All backup settings can
   be updated later in Settings and persist in ``/data/config.json``.
6. Open Identity to configure Omni's callback and copy the OIDC and S3 credentials.
   Expose the S3 receiver (container port 9000) to Omni, not to the public internet.
7. In Backups, upload Omni recovery keys/configuration and create your first recovery file.

The setup token, account password, and backup passphrase are different secrets.
The web listener is port 8080; the S3 receiver starts after initialization on port 9000.
The wizard can also encrypt a recovery copy of the passphrase to age or SSH public keys,
including supported keys imported from GitHub. Keep the matching private key yourself.
Decrypt the note locally with age, then use its recovered passphrase with the .tcb backup.

## Optional NFS / SMB destination

Mount the share on the Unraid host and map that existing mount to ``/destinations/network``.
Only then set MOUNTED_BACKUP_DIR to ``/destinations/network``. The container requires
no mount privileges or SMB/NFS utilities. Confirm the host mount is actually available;
an empty directory at the mountpoint does not prove the share is connected.

## Recovery

Restore on an uninitialized data directory using a version 2 ``.tcb`` recovery file and
its original passphrase. You can override the first administrator's credentials while
preserving identity and other users. Restore includes accounts, integration credentials,
vault files, received snapshots, and schedule/retention configuration. Future backups
use the replacement container's BACKUP_PASSPHRASE. Allow disk space for both the uploaded
encrypted file and extracted contents, and configure proxy limits for large uploads.

Companion does not collect Omni encryption keys or snapshot Omni's own database automatically.
Configure Omni to send supported S3 backups and explicitly upload its recovery keys/configuration.
Test recovery with your Omni deployment before relying on it.

## Support

Report problems at $publicBase/issues. Do not attach passwords, tokens, encryption keys,
or recovery files to issues. This project is independent of Sidero Labs and Talos Omni.
"@
Set-Content -LiteralPath (Join-Path $outputPath 'README.md') -Value $readme -Encoding utf8NoBOM
[xml]$checkedTemplate = Get-Content -LiteralPath (Join-Path $templatePath 'talos-companion.xml') -Raw
[xml]$checkedProfile = Get-Content -LiteralPath (Join-Path $outputPath 'ca_profile.xml') -Raw
if ($checkedTemplate.Container.Repository -ne "${image}:latest" -or [string]::IsNullOrWhiteSpace($checkedProfile.CommunityApplications.Profile)) {
    throw 'Generated template failed validation'
}
foreach ($name in @('SETUP_TOKEN', 'BACKUP_PASSPHRASE')) {
    $setting = $checkedTemplate.Container.Config | Where-Object Target -eq $name
    if ($null -eq $setting -or -not [string]::IsNullOrWhiteSpace($setting.InnerText) -or -not [string]::IsNullOrWhiteSpace($setting.Default)) {
        throw 'A secret placeholder must exist and remain empty in the distributable template'
    }
}
Write-Output "Prepared private template-only repository contents at $outputPath"
