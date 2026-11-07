# Google Drive backups

Companion uploads encrypted `.tcb` recovery files using a native Rust HTTPS client. No external executable runs in the container.

1. In your own Google Cloud project, enable the **Google Drive API**.
2. Configure an OAuth consent screen and create an OAuth client of type **Web application**.
3. Register `https://YOUR-COMPANION-ORIGIN/oauth/google/callback` as an authorized redirect URI. It must exactly match `PUBLIC_URL` plus that path. For local testing, Google permits localhost HTTP redirect URIs.
4. In Companion → Backups, choose **Set up Google Drive**, then enter the client ID and client secret. Leave the folder ID empty to have Companion create a dedicated **Talos Companion backups** folder during authorization. You may instead reuse a folder previously created by this same OAuth application.
5. Choose Save and authorize, then sign in to Google and grant the requested access. After the callback, Drive is shown as connected.
6. In Backups, choose **Back up to Drive**. For scheduled copies, choose **Google Drive** in **Backups → Backup settings**.

The application requests `https://www.googleapis.com/auth/drive.file`, which limits it to files it creates or explicitly opens with the OAuth application. Supplying an arbitrary existing folder ID does not grant access to that folder. Letting Companion create the folder avoids that issue without requesting full Drive access.

The refresh token, client secret, and destination folder ID are persisted in `/data/state.json` and included in encrypted backups. They are not sent to the frontend after authorization. The OAuth client ID and folder ID are visible to administrators. Revoking the grant prevents further uploads until you reconnect.

Google OAuth applications left in external **Testing** mode commonly issue refresh tokens that expire after seven days for Drive scopes. For unattended backups, configure the consent-screen publishing/user type appropriately for your account and verify a later scheduled upload. Google may require consent-screen review depending on your configuration. Do not rely on a one-time successful upload as evidence that future refreshes will remain valid.

Every Drive upload first creates a local encrypted file. If Google is unavailable or the grant expires, the local file remains available for download. The UI reports transfer failure, and scheduled failures go to container logs. Files are read from disk using Google's resumable-upload protocol in bounded 8 MiB chunks, with no archive size cap. Access tokens are refreshed between chunks when needed, so multi-hour transfers are not limited by one token's lifetime. A failed network transfer must be retried as a new backup.

After successful upload, the recovery retention setting in **Backups → Backup settings** (default seven, `0` disables) controls retention in the configured folder. Only recovery files tagged by this application are candidates; unrelated Drive files are untouched. Expired files are moved to Trash rather than permanently deleted. Use a dedicated folder for this instance. Retention errors are reported alongside transfer errors, while the local recovery file remains available.

References: [Drive OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), and [Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
