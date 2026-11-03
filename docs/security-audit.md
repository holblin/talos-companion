# Publication credential audit — 2026-11-02

Before making this repository public, the following were reviewed:

- All 12 existing commits across fetched Git refs, plus the publication commit, with
  Gitleaks 8.30.1 and full redaction enabled. No credential findings.
- A clean export of tracked files, separately from ignored development/runtime data.
  No credential findings. The final generated template bundle was scanned separately.
- Logs from all 15 existing GitHub Actions runs. No credential findings.
- All three available template artifact bundles. No credential findings. Image artifacts
  are the CI-verified image archives containing only the static binary and compiled frontend.
- All three committed UI screenshots were visually reviewed. They contain isolated test
  data and no displayed passwords, tokens, private keys or recovery passphrases.
- GitHub had no issues or releases to audit at publication. Runtime data, local launch
  configuration, private keys and recovery archives are excluded from Git.

Fixture credentials in tests are deliberately fake and used only in isolated test servers.
Documentation examples use placeholders. Machine-specific deployment notes were removed
from current public documentation; older history contains LAN deployment metadata, not
credentials. No history rewrite was needed for credential removal.

The Docker Hub publishing token is an encrypted GitHub Actions secret, not repository
content. Repository visibility does not expose its stored value. Workflows keep it out
of command arguments and log output. Public contributors must never be given this token.

Gitleaks is now pinned through mise. `mise run secrets:check` scans all Git history;
CI checks out full history and runs this task. Ignore rules also cover local environment
overrides, age/GPG/private-key files and generated startup secrets.

This is a credential-exposure review, not a penetration test or a guarantee that every
possible secret format can be detected. Do not commit populated Omni configuration,
`.env` files, credentials, production logs or backups. Report a suspected credential
exposure privately to the repository owner; do not paste the value into a public issue.
