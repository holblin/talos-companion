# Companion access and Omni configuration

Companion has two separate menu items:

- **Companion access** adds and checks Local HTTPS, Tailscale and Cloudflare independently.
  You can configure all three simultaneously. Adding or rechecking a method does not
  change the canonical identity-provider URL used by Omni.
- **Omni configuration** requires a verified access method. Select the method Omni
  will use, explicitly accept any issuer change, then configure Omni’s sign-in and
  backup settings using the automatically filled endpoints.

No additional container, Docker flag, environment variable, port or privilege is
required. Keep the existing appdata mount across updates.

## Companion access

Each method has its own card with its address, last verification time and a check
button. Local HTTPS also offers a public certificate download when Companion
created its certificate. A failed check marks that method as needing verification;
other methods and the active issuer remain unchanged.

Choose **Add Local HTTPS**, **Add Tailscale** or **Add Cloudflare**:

1. **Prepare HTTPS.** Local setup creates a private certificate on the existing
   web port. Download its public CA, install it on browser devices and in the trust
   store used by Omni, and confirm the HTTPS page opens without a warning. Cloudflare
   and Tailscale guide you through browser authorization and configure their routes.
2. **Verify and save.** Companion checks HTTPS, installation identity, OpenID
   discovery and signing keys before saving the method. Other configured methods
   remain available. This step does not activate or migrate the Omni issuer.

Use **Manage** to verify an existing method or return to its setup, and **Check**
to repeat its live verification. To update a saved Companion URL, open **Manage**,
expand **Advanced settings**, edit **Companion HTTPS address**, and choose **Save
access method**. For Cloudflare, saving creates DNS for a subdomain of the approved
zone and adds its route to the existing tunnel, preserving old hostnames and the
Omni and backup endpoints. Conflicting DNS records are not overwritten.
For Tailscale, saving renames the device within its current tailnet and updates
all three HTTPS endpoints. The old Tailscale hostname stops working. If it is
Omni’s active issuer, select another verified access method for Omni first.
Make the change through Local HTTPS or Cloudflare so the page stays connected.
Saving waits for provider configuration and HTTPS verification before recording
verified access. If propagation takes longer, retry saving; completed provider
changes are retained. Local HTTPS URL edits still require existing routing.
Methods from older configurations appear as
**Needs verification** until successfully checked. The old /identity page remains
an alias for Omni configuration; new links use /access and /omni-configuration.

Cloudflare and Tailscale have independent provider state. Adding Tailscale keeps
an existing Cloudflare tunnel running, including after a Companion restart.
Switching Omni’s selected method does not delete tunnels, revoke provider grants
or stop your other access methods.

## Omni configuration

1. **Choose verified Companion access.** Only methods that have passed verification
   are selectable. Companion rechecks the chosen address before using it. A change
   to the canonical issuer requires explicit consent because Omni’s existing
   sign-in configuration must be updated. Activation persists the issuer and updates
   OpenID discovery and token issuance immediately, without restarting Companion.
   Outstanding authorization codes are revoked when the issuer changes.
2. **Find Omni.** Confirm or enter your existing Omni address. The selected method
   fills in the Companion and backup endpoints automatically. For a private Omni
   CA, paste its public PEM certificate in Advanced settings.
3. **Check and configure.** Verify Companion, Omni and S3, save the network, preview
   and download the Omni overlay and S3 resource, and register its callback. Apply
   the files to Omni, restart Omni, test sign-in and make a real backup. Existing
   managed installations can apply their overlay directly.

Companion advertises one canonical OIDC issuer even when it has multiple HTTPS
addresses. Browser access through another configured method does not change it.
Network checks do not claim that a remote Omni server has applied its configuration.
Companion has no host Docker socket or remote Omni administration credentials.
Manual endpoint overrides, imports and credentials remain under Advanced settings.
The Companion issuer is chosen from the access catalogue rather than edited in
Omni’s service-address overrides.

## Local HTTPS

HTTP bootstrap and HTTPS share Companion’s existing published web port. Provider
relays can continue using the internal HTTP listener. Local S3 uses the same HTTPS
origin, with authenticated streaming access to the omni bucket. The original S3
port remains available for existing deployments.

Use a stable LAN hostname or IP that Omni and browser clients can reach. If you
opened Companion through a cloud route, enter its local address in Advanced settings
before preparing local HTTPS. Certificates last one year; run Prepare local HTTPS
again to renew them. Renewal preserves the CA and existing trust installations.
A private CA is not automatically trusted by browsers or a remote Omni host.

Private CA and server keys stay under /data/connections/private. Only the public
CA is downloadable, by a signed-in administrator. Preserve appdata: recovery exports
do not include access/provider state or those certificate keys. After restoring
without appdata, recreate access methods and reinstall any regenerated local CA.

## Provider connections

Cloudflare uses official cloudflared browser authorization, creates a tunnel and
DNS routes for talos-companion.DOMAIN, omni.DOMAIN and s3.DOMAIN, and runs the tunnel.
Choose **Continue with Cloudflare**, open its sign-in page, select a domain already
managed by Cloudflare and approve it. Return to Companion; it detects the approved
domain, creates the addresses and automatically checks Companion HTTPS before you
save. No token, zone ID or Docker parameter is required. If your authorization cannot
read the domain name, enter that same domain under **Advanced settings** and retry.
Existing authorization is reused. Advanced settings also supports an explicit domain
override; it must belong to the approved Cloudflare zone.
Existing DNS records are not forcibly overwritten. DNS/certificate propagation
may require a recheck. Cloudflare request/upload limits apply to public traffic.

Tailscale authorizes a dedicated userspace device and discovers its .ts.net hostname.
Private HTTPS routes use ports 443, 8443 and 10000 automatically. Browser devices and
Omni’s host need tailnet access. Funnel and privileged networking are not enabled.

## What live checks prove

| Service | Verification |
| --- | --- |
| Companion access | HTTPS, instance-bound challenge, OpenID discovery and signing keys. |
| Omni | Successful HTTP response/redirect and certificate verification for HTTPS. |
| Backup receiver | Instance identity, then signed read-only access to the omni bucket. |

Cookies are never forwarded to candidate addresses. S3 credentials are used only
after the receiver proves it belongs to this installation. Saving access, choosing
an issuer and saving the network repeat their respective checks on the server.

Checks originate from Companion. A real Omni backup verifies the Omni-to-S3 path.
Talos node routing, SideroLink/WireGuard, machine API and Kubernetes proxy access
are separate from web routes. A Cloudflare HTTP tunnel alone does not supply those
node-network paths.
