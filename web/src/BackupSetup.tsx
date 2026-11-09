import { useState } from "react";
import { Button } from "@react-spectrum/s2/Button";
import { Form } from "@react-spectrum/s2/Form";
import { Picker, PickerItem } from "@react-spectrum/s2/Picker";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Dialog } from "@react-spectrum/s2/Dialog";
import { DialogContainer } from "@react-spectrum/s2/Dialog";
import { Heading } from "@react-spectrum/s2/Heading";
import { Content } from "@react-spectrum/s2/Content";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Input from "./Field";
import { api } from "./api";
import { classes, documentClass } from "./layout";
import { useTask } from "./useTask";
import ContextHelp from "./ContextHelp";
import { ContextualHelp } from "@react-spectrum/s2/ContextualHelp";

type Drive = { client_id: string; folder_id: string; connected: boolean };
export type NetworkShare = {
  protocol: "nfs" | "smb";
  host: string;
  share: string;
  directory: string;
  username: string;
  uid: number;
  gid: number;
};
type DestinationInfo = {
  issuer: string;
  mounted: string | null;
  drive: Drive;
  network?: NetworkShare | null;
};

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
          <ButtonGroup slot={null}>
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
          </ButtonGroup>
        </>
      ) : (
        <>
          <p className={documentClass("p")}>
            Step 1 of 2 · Set up your Google application once
          </p>
          <ContextHelp title="Google Cloud setup instructions">
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
                Configure the OAuth consent screen, then create an OAuth client
                of type <b>Web application</b> in{" "}
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
          </ContextHelp>
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

export function NetworkShareSetup({
  configured,
  refresh,
}: {
  configured?: NetworkShare | null | undefined;
  refresh: () => Promise<void>;
}) {
  const [protocol, setProtocol] = useState(configured?.protocol ?? "smb");
  const [saved, setSaved] = useState(false);
  const { busy, error, work } = useTask();
  return (
    <>
      <p className={documentClass("p")}>
        Connect directly to your NAS. No host mount or Docker volume is needed.
        The check creates, reads, and removes a temporary file before saving
        this destination.
      </p>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(event.currentTarget));
          setSaved(false);
          void work(async () => {
            await api("/api/backups/network", {
              protocol,
              host: data["host"],
              share: data["share"],
              directory: data["directory"],
              username: protocol === "smb" ? data["username"] : "",
              password: protocol === "smb" ? data["password"] : "",
              uid:
                protocol === "nfs"
                  ? Number(
                      typeof data["uid"] === "string"
                        ? data["uid"].replaceAll(",", "")
                        : NaN,
                    )
                  : 99,
              gid:
                protocol === "nfs"
                  ? Number(
                      typeof data["gid"] === "string"
                        ? data["gid"].replaceAll(",", "")
                        : NaN,
                    )
                  : 100,
            });
            setSaved(true);
            await refresh();
          });
        }}
      >
        <Picker
          label="Share protocol"
          value={protocol}
          onChange={(value) => {
            setProtocol(value === "nfs" ? "nfs" : "smb");
            setSaved(false);
          }}
        >
          <PickerItem id="smb">SMB</PickerItem>
          <PickerItem id="nfs">NFSv3</PickerItem>
        </Picker>
        <Input
          label="Server hostname or IP address"
          name="host"
          defaultValue={configured?.host ?? ""}
        />
        <Input
          key={protocol}
          label={protocol === "nfs" ? "NFS export path" : "SMB share name"}
          name="share"
          defaultValue={
            configured?.protocol === protocol ? configured.share : ""
          }
          placeholder={protocol === "nfs" ? "/exports/backups" : "Backups"}
        />
        <Input
          label="Directory within share (optional)"
          name="directory"
          required={false}
          defaultValue={configured?.directory ?? ""}
        />
        <p className={documentClass("p")}>
          Use an existing, dedicated directory for this instance. Leave the
          directory empty to use the share root.
        </p>
        {protocol === "smb" ? (
          <>
            <Input
              label="SMB username"
              name="username"
              defaultValue={configured?.username ?? ""}
            />
            <Input
              label="SMB password"
              name="password"
              type="password"
              required={!configured || configured.protocol !== "smb"}
              autoComplete="new-password"
            />
            {configured?.protocol === "smb" && (
              <p className={documentClass("p")}>
                Leave the password empty to keep it for the same server, share,
                and username.
              </p>
            )}
          </>
        ) : (
          <>
            <Input
              label="NFS user ID (UID)"
              name="uid"
              type="number"
              min={0}
              max={4294967295}
              step={1}
              defaultValue={configured?.uid ?? 99}
            />
            <Input
              label="NFS group ID (GID)"
              name="gid"
              type="number"
              min={0}
              max={4294967295}
              step={1}
              defaultValue={configured?.gid ?? 100}
            />
            <p className={documentClass("p")}>
              NFSv3 uses export permissions and numeric user/group IDs. Allow
              this server’s IP on your NAS, including connections from
              unprivileged ports.
            </p>
          </>
        )}
        {error && (
          <p className={documentClass("p")} role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className={documentClass("p")} role="status">
            Share access verified and destination saved. You can back up now or
            select Remote NFS / SMB for scheduled backups.
          </p>
        )}
        <Button type="submit" variant="accent" isDisabled={busy}>
          {busy ? "Checking share…" : "Check access and save"}
        </Button>
      </Form>
    </>
  );
}

export default function BackupDestinations({
  initialEditing = null,
  overview,
  createBackup,
  refresh,
}: {
  initialEditing?: "drive" | "network" | null;
  overview: DestinationInfo;
  createBackup: (destination: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<"drive" | "network" | null>(
    initialEditing,
  );
  const destinations = [
    {
      id: "local",
      title: "Local storage",
      location: "/data/backups",
      status: "Ready",
      configured: true,
      help: "Encrypted recovery files are kept in the persistent data directory. Map a host folder to /data/backups to use mounted storage.",
    },
    {
      id: "drive",
      title: "Google Drive",
      location: overview.drive.folder_id || "Dedicated backup folder",
      status: overview.drive.connected ? "Connected" : "Not connected",
      configured: overview.drive.connected,
      help: "Send an encrypted copy to Google Drive. A local copy is always kept too.",
    },
    {
      id: "network",
      title: "NFS / SMB",
      location: overview.network
        ? overview.network.host + "/" + overview.network.share
        : "No share configured",
      status: overview.network
        ? "Connected via " + overview.network.protocol.toUpperCase()
        : "Not connected",
      configured: !!overview.network,
      help: "Save encrypted recovery files on your NAS or network share.",
    },
  ] as const;
  return (
    <>
      <div className={classes("three-cols")}>
        {destinations.map((destination) => (
          <section
            key={destination.id}
            className={classes("card")}
            aria-label={destination.title}
          >
            <div
              className={style({
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              })}
            >
              <h2 className={documentClass("h2")}>{destination.title}</h2>
              <ContextualHelp>
                <Heading slot="title">About {destination.title}</Heading>
                <Content>{destination.help}</Content>
              </ContextualHelp>
            </div>
            <StatusLight
              variant={destination.configured ? "positive" : "neutral"}
            >
              {destination.status}
            </StatusLight>
            <p
              className={style({
                font: "body-sm",
                color: "neutral-subdued",
                overflowWrap: "anywhere",
                marginY: 12,
              })}
            >
              {destination.location}
            </p>
            <ButtonGroup>
              {destination.id !== "local" && (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setEditing(
                      destination.id === "drive" ? "drive" : "network",
                    );
                  }}
                >
                  {destination.configured ? "Manage " : "Set up "}
                  {destination.title}
                </Button>
              )}
              {destination.configured && (
                <Button
                  variant="secondary"
                  onPress={() => void createBackup(destination.id)}
                >
                  {destination.id === "local"
                    ? "Create local backup →"
                    : destination.id === "drive"
                      ? "Back up to Drive →"
                      : "Back up to share →"}
                </Button>
              )}
            </ButtonGroup>
          </section>
        ))}
      </div>
      <DialogContainer
        onDismiss={() => {
          setEditing(null);
        }}
      >
        {editing && (
          <Dialog
            size="L"
            aria-label={
              editing === "drive" ? "Google Drive setup" : "Network share setup"
            }
          >
            <Heading slot="title">
              {editing === "drive"
                ? "Connect Google Drive"
                : "Connect NFS / SMB"}
            </Heading>
            <Content>
              {editing === "drive" ? (
                <GoogleDriveSetup
                  issuer={overview.issuer}
                  drive={overview.drive}
                />
              ) : (
                <NetworkShareSetup
                  configured={overview.network}
                  refresh={refresh}
                />
              )}
            </Content>
            <ButtonGroup>
              <Button
                variant="secondary"
                onPress={() => {
                  setEditing(null);
                }}
              >
                Close setup
              </Button>
            </ButtonGroup>
          </Dialog>
        )}
      </DialogContainer>
    </>
  );
}
