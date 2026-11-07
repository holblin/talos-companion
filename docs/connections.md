# Connect Omni from the UI

Cloudflare and Tailscale are included in the normal Companion image. Update the
existing container, retaining its appdata mount, ports and permissions. There is
no second container, connector installation, or connection-specific Docker option.

Open **Identity → Connect your Omni**:

1. **Choose a connection.** Select This network (LAN), Cloudflare, or Tailscale.
2. **Find your Omni.** Confirm the discovered address or paste the address you use
   to open Omni. A hostname is enough; a full web address also works. Companion
   checks it before continuing.
3. **Sign in.** For Cloudflare, enter your zone domain, approve the public routes,
   and open the Cloudflare sign-in link. For Tailscale, approve the Companion
   device and any HTTPS request using its link. Return here; the wizard continues
   automatically. LAN connections skip this step.
4. **Check and save.** Companion generates the addresses and checks all three
   services. Save once Companion, Omni and the backup receiver pass their checks.

The saved connection appears as a summary with **Change connection** and **Check
connection** buttons. Its Companion web address can be used after saving. Existing
OIDC issuer and Omni account settings are preserved; explicit sign-in/backup
migrations remain under **Advanced settings → Omni account configuration**.

## Advanced settings

Normal setup does not require entering listener ports, backend environment
variables, control directories, provider credentials, or Docker flags.

- For a private Omni certificate authority, paste its **public PEM trust
  certificate** in Advanced settings on the address step. Never paste a private
  key. TLS verification stays enabled.
- Manual service-address overrides and Omni configuration imports/overlays are
  under Advanced settings on the final step.

## Connection details

Cloudflare uses the official cloudflared browser authorization flow, creates a
tunnel and DNS routes for companion.DOMAIN, omni.DOMAIN and s3.DOMAIN, and runs the
tunnel. Existing DNS records are not forcibly overwritten. Use a zone domain with
appropriate certificate coverage; DNS/certificate propagation may need a recheck.
Cloudflare request/upload limits apply to public tunnel traffic.

Tailscale authorizes a dedicated userspace device and discovers its actual .ts.net
hostname. Private HTTPS routes use ports 443, 8443 and 10000 automatically. Funnel,
host-wide VPN routes and privileged networking are not enabled.

Companion supervises the bundled clients internally. Private provider state lives
under /data/connections/private in the existing appdata mount. It is not exposed
by the HTTP API or included in recovery exports. Preserve appdata across updates.
Switching methods does not delete previous provider resources or revoke grants;
manage those in the provider account when no longer wanted.

## What checks prove

| Service | Verification |
| --- | --- |
| Companion | Instance-bound challenge/response; TLS for HTTPS addresses. |
| Omni | Successful HTTP response/redirect; TLS for HTTPS addresses. |
| Backup receiver | Instance identity, then signed read-only access to the omni bucket. |

Cookies are not forwarded to candidate addresses. S3 credentials are used only
after the receiver proves it belongs to this installation. Changing an address
invalidates results; saving repeats the checks on the server.

Checks run from Companion. A real Omni backup verifies the Omni-to-S3 path. Talos
node routing, SideroLink/WireGuard, machine API and Kubernetes proxy access are
separate from these web routes; a Cloudflare HTTP tunnel alone does not provide
those node-network paths. Plain HTTP LAN overrides remain unencrypted.
