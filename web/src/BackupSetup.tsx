import { useEffect, useRef, useState } from "react";
import {
  Button,
  Form,
  Picker,
  PickerItem,
  StatusLight,
} from "@react-spectrum/s2";
import Input from "./Field";
import { api } from "./api";
import { classes, documentClass, layout } from "./layout";
import { useTask } from "./useTask";

type Drive = { client_id: string; folder_id: string; connected: boolean };
type DestinationInfo = { issuer: string; mounted: string | null; drive: Drive };

export function BackupFrequency({ seconds }: { seconds: number }) {
  const [frequency, setFrequency] = useState(
    [3600, 86400, 604800].includes(seconds) ? String(seconds) : "custom",
  );
  return (
    <>
      <Picker
        label="Backup frequency"
        value={frequency}
        onChange={(value) => {
          setFrequency(String(value));
        }}
      >
        <PickerItem id="3600">Every hour</PickerItem>
        <PickerItem id="86400">Every day</PickerItem>
        <PickerItem id="604800">Every week</PickerItem>
        <PickerItem id="custom">Custom interval</PickerItem>
      </Picker>
      {frequency === "custom" ? (
        <Input
          label="Backup interval (seconds)"
          name="interval_seconds"
          type="number"
          min={60}
          max={31536000}
          step={1}
          defaultValue={seconds}
        />
      ) : (
        <input type="hidden" name="interval_seconds" value={frequency} />
      )}
      <p className={documentClass("p", classes("hint"))}>
        Saving resets the schedule timer.
      </p>
    </>
  );
}

export function GoogleDriveSetup({
  issuer,
  drive,
}: {
  issuer: string;
  drive: Drive;
}) {
  const [editing, setEditing] = useState(!drive.client_id);
  const { busy, error, work } = useTask();
  function authorize() {
    return work(async () => {
      const result = await api<{ url: string }>("/api/drive/connect", {});
      location.assign(result.url);
    });
  }
  return (
    <>
      <p className={documentClass("p")}>
        Sign in to Google to allow encrypted backups. Companion creates a
        dedicated backup folder automatically and keeps a local copy too.
      </p>
      {error && (
        <p className={documentClass("p")} role="alert">
          {error}
        </p>
      )}
      {!editing ? (
        <>
          <p className={documentClass("p")}>
            Your Google application is saved. Continue to Google to approve
            access.
          </p>
          <Button
            variant="accent"
            isDisabled={busy}
            onPress={() => void authorize()}
          >
            {busy
              ? "Opening Google…"
              : drive.connected
                ? "Reconnect Google Drive ↗"
                : "Sign in with Google ↗"}
          </Button>
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              setEditing(true);
            }}
          >
            Change Google application
          </Button>
        </>
      ) : (
        <>
          <p className={documentClass("p")}>
            Step 1 of 2 · Set up your Google application once
          </p>
          <p className={documentClass("p")}>
            This self-hosted installation needs your own Google OAuth
            application before Google can offer sign-in. Your client secret
            stays on this server.
          </p>
          <ol>
            <li>
              Open{" "}
              <a
                className={documentClass("a")}
                href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                target="_blank"
                rel="noreferrer"
              >
                Google Cloud
              </a>
              , choose a project, and enable the Google Drive API.
            </li>
            <li>
              Configure the OAuth consent screen, then create an OAuth client of
              type <b>Web application</b> in{" "}
              <a
                className={documentClass("a")}
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
              >
                Credentials
              </a>
              .
            </li>
            <li>Register this exact authorized redirect URI:</li>
          </ol>
          <code className={documentClass("code", classes("block"))}>
            {issuer}/oauth/google/callback
          </code>
          <Form
            isDisabled={busy}
            onSubmit={(event) => {
              event.preventDefault();
              const data = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              void work(async () => {
                await api("/api/drive", data);
                // Keep the saved-application screen available if opening Google fails.
                setEditing(false);
                const result = await api<{ url: string }>(
                  "/api/drive/connect",
                  {},
                );
                location.assign(result.url);
              });
            }}
          >
            <Input
              label="Google client ID"
              name="client_id"
              defaultValue={drive.client_id}
            />
            <Input
              label="Google client secret"
              name="client_secret"
              type="password"
              autoComplete="off"
            />
            <details className={documentClass("details")}>
              <summary className={documentClass("summary")}>
                Use an existing backup folder (optional)
              </summary>
              <Input
                label="Destination folder ID (optional)"
                name="folder_id"
                required={false}
                defaultValue={drive.folder_id}
                placeholder="Leave empty to create a dedicated folder"
              />
              <p className={documentClass("p")}>
                Use a folder created by this Google application. An arbitrary
                folder ID does not grant access.
              </p>
            </details>
            <Button type="submit" variant="accent">
              {busy ? "Opening Google…" : "Save and authorize Google Drive ↗"}
            </Button>
          </Form>
          <p className={documentClass("p", classes("hint"))}>
            Step 2: approve access in Google, then return here. Companion only
            requests access to files created by this application. Google grants
            in Testing mode may expire after seven days; use an appropriate
            publishing status for unattended backups.
          </p>
        </>
      )}
    </>
  );
}

export default function BackupDestinations({
  overview,
  createBackup,
  refresh,
}: {
  overview: DestinationInfo;
  createBackup: (destination: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<"drive" | "mounted" | null>(null);
  const [checkedPath, setCheckedPath] = useState<string | null>(null);
  const setupHeading = useRef<HTMLHeadingElement>(null);
  const setupTriggers = useRef<
    Partial<Record<"drive" | "mounted", { focus(): void } | null>>
  >({});
  const previousEditing = useRef<"drive" | "mounted" | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) setupHeading.current?.focus();
    else if (wasEditing.current && previousEditing.current)
      setupTriggers.current[previousEditing.current]?.focus();
    if (editing) previousEditing.current = editing;
    wasEditing.current = editing !== null;
  }, [editing]);
  const { busy, error, work } = useTask();
  const verified = !!overview.mounted && checkedPath === overview.mounted;
  return (
    <section aria-label="Backup destinations">
      {!editing && (
        <>
          <h2 className={documentClass("h2")}>Backup destinations</h2>
          <p className={documentClass("p")}>
            Choose where to keep your encrypted recovery files. Configure Google
            Drive or a network share for an additional copy. A local copy is
            always kept too.
          </p>
          <div className={classes("three-cols")}>
            <section
              className={classes("card destination-card")}
              aria-label="Local storage"
            >
              <h3 className={documentClass("h3", layout.destinationTitle)}>
                Local storage
              </h3>
              <p className={documentClass("p", layout.destinationDescription)}>
                Save an encrypted recovery file in the persistent data
                directory. Download it whenever you need it. No setup needed.
              </p>
              <StatusLight variant="positive">Ready to back up</StatusLight>
              <Button
                variant="secondary"
                onPress={() => void createBackup("local")}
              >
                Create local backup →
              </Button>
            </section>
            <section
              className={classes("card destination-card")}
              aria-label="Google Drive"
            >
              <h3 className={documentClass("h3", layout.destinationTitle)}>
                Google Drive
              </h3>
              <p className={documentClass("p", layout.destinationDescription)}>
                Send an encrypted copy to Google Drive. A local copy is always
                kept too.
              </p>
              <StatusLight
                variant={overview.drive.connected ? "positive" : "neutral"}
              >
                {overview.drive.connected
                  ? "Connected"
                  : overview.drive.client_id
                    ? "Awaiting Google sign-in"
                    : "Not configured"}
              </StatusLight>
              <Button
                ref={(element) => {
                  setupTriggers.current.drive = element;
                }}
                variant={overview.drive.connected ? "secondary" : "accent"}
                onPress={() => {
                  setEditing("drive");
                }}
              >
                {overview.drive.connected
                  ? "Manage Google Drive"
                  : "Set up Google Drive"}
              </Button>
              {overview.drive.connected && (
                <Button
                  variant="secondary"
                  onPress={() => void createBackup("drive")}
                >
                  Back up to Drive →
                </Button>
              )}
            </section>
            <section
              className={classes("card destination-card")}
              aria-label="NFS / SMB"
            >
              <h3 className={documentClass("h3", layout.destinationTitle)}>
                NFS / SMB
              </h3>
              <p className={documentClass("p", layout.destinationDescription)}>
                Save an encrypted copy on your NAS or network share.
              </p>
              <StatusLight variant={verified ? "positive" : "neutral"}>
                {verified
                  ? "Write check passed"
                  : overview.mounted
                    ? "Configured · check access"
                    : "Not configured"}
              </StatusLight>
              <Button
                ref={(element) => {
                  setupTriggers.current.mounted = element;
                }}
                variant={overview.mounted ? "secondary" : "accent"}
                onPress={() => {
                  setEditing("mounted");
                }}
              >
                {overview.mounted ? "Manage NFS / SMB" : "Set up NFS / SMB"}
              </Button>
              {overview.mounted && (
                <Button
                  variant="secondary"
                  onPress={() => void createBackup("mounted")}
                >
                  Back up to share →
                </Button>
              )}
            </section>
          </div>
        </>
      )}
      {editing && (
        <section
          className={classes("card")}
          aria-label={
            editing === "drive" ? "Google Drive setup" : "Network share setup"
          }
        >
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              setEditing(null);
            }}
          >
            Back to backup destinations
          </Button>
          <h2
            className={documentClass("h2", layout.setupHeading)}
            ref={setupHeading}
            tabIndex={-1}
          >
            {editing === "drive" ? "Connect Google Drive" : "Connect NFS / SMB"}
          </h2>
          {editing === "drive" ? (
            <GoogleDriveSetup issuer={overview.issuer} drive={overview.drive} />
          ) : (
            <>
              <p className={documentClass("p")}>
                Mount your share once on the host, then check it here. Companion
                runs without host mount privileges, so NAS credentials stay with
                the host.
              </p>
              <ol>
                <li>
                  In Unraid, use Unassigned Devices to add your NFS or SMB share
                  and enable automatic mounting. Enter any share credentials
                  there.
                </li>
                <li>
                  In the Companion container settings, add a Path from that
                  mounted host folder to{" "}
                  <code className={documentClass("code")}>
                    /destinations/network
                  </code>
                  , with Read/Write access.
                </li>
                <li>
                  Add the variable{" "}
                  <code className={documentClass("code")}>
                    MOUNTED_BACKUP_DIR
                  </code>{" "}
                  with value{" "}
                  <code className={documentClass("code")}>
                    /destinations/network
                  </code>
                  , then apply the container changes and return to this page.
                </li>
              </ol>
              <details className={documentClass("details")}>
                <summary className={documentClass("summary")}>
                  Using Docker Compose instead?
                </summary>
                <p className={documentClass("p")}>
                  Mount the share on your Docker host first. Add these entries
                  to the Companion service, keeping its existing environment and
                  volumes:
                </p>
                <pre className={documentClass("pre")}>
                  <code className={documentClass("code")}>
                    {
                      "environment:\n  MOUNTED_BACKUP_DIR: /destinations/network\nvolumes:\n  - /path/to/mounted/share:/destinations/network"
                    }
                  </code>
                </pre>
              </details>
              <p className={documentClass("p")}>
                Container destination:{" "}
                <code className={documentClass("code")}>
                  {overview.mounted ?? "Not detected yet"}
                </code>
              </p>
              <p className={documentClass("p")}>
                The check creates, reads, and removes a small temporary file.
                Confirm on the host that this folder is the mounted share; a
                writable folder alone cannot prove the NAS is mounted.
              </p>
              {error && (
                <p className={documentClass("p")} role="alert">
                  {error}
                </p>
              )}
              {verified && (
                <p className={documentClass("p")} role="status">
                  Share write check passed. You can back up now or choose NFS /
                  SMB in Scheduled destination under Backup schedule and
                  retention.
                </p>
              )}
              <Button
                variant="accent"
                isDisabled={busy}
                onPress={() => {
                  setCheckedPath(null);
                  void work(async () => {
                    const result = await api<{ path: string }>(
                      "/api/backups/mounted/check",
                      {},
                    );
                    await refresh();
                    setCheckedPath(result.path);
                  });
                }}
              >
                {busy ? "Checking share…" : "Check share access"}
              </Button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
