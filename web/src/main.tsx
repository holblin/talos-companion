import { StrictMode, useEffect, useState } from "react";
import type { SubmitEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { api } from "./api";
import SetupWizard from "./SetupWizard";
import OmniSetup from "./OmniSetup";

type User = { id: string; email: string; name: string; admin: boolean };
type Backup = { name: string; bytes: number };
type Settings = {
  retention: { recovery_keep_last: number; snapshot_keep_last: number };
  schedule: { enabled: boolean; interval_seconds: number; destination: string };
};
type Overview = {
  settings: Settings;
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  s3_access_key: string;
  s3_secret_key: string;
  bucket: string;
  mounted: string | null;
  drive: { client_id: string; folder_id: string; connected: boolean };
  streaming_backups: boolean;
  retention: { recovery_keep_last: number; snapshot_keep_last: number };
};
type View = "Overview" | "Backups" | "Identity" | "Accounts" | "Settings";
const views: View[] = [
  "Overview",
  "Backups",
  "Identity",
  "Accounts",
  "Settings",
];
const symbols = ["◈", "↗", "◎", "⊞", "⚙"];
function fields(e: SubmitEvent<HTMLFormElement>) {
  e.preventDefault();
  const result: Record<string, string> = {};
  for (const [key, value] of new FormData(e.currentTarget)) {
    if (typeof value !== "string")
      throw new Error("Expected a text form field.");
    result[key] = value;
  }
  return result;
}
function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      T<span>+</span>
    </span>
  );
}
function Input({
  label,
  name,
  type = "text",
  required = true,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} required={required} {...rest} />
    </label>
  );
}
function Card({
  title,
  eyebrow,
  children,
  className = "",
}: {
  title?: string;
  eyebrow?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}
function Secret({ label, value }: { label: string; value: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="secret">
      <span>{label}</span>
      <div>
        <code>{show ? value : "••••••••••••••••••••••••"}</code>
        <button
          className="text-button"
          onClick={() => {
            setShow(!show);
          }}
        >
          {show ? "Hide" : "Reveal"}
        </button>
      </div>
    </div>
  );
}
function AccountFields({ optionalName = false }: { optionalName?: boolean }) {
  return (
    <>
      {!optionalName && (
        <Input label="Display name" name="name" autoComplete="name" />
      )}
      <Input
        label="Email address"
        name="email"
        type="email"
        autoComplete="username"
      />
      <Input
        label="Password"
        name="password"
        type="password"
        minLength={12}
        autoComplete="new-password"
      />
    </>
  );
}

function App() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState<View>("Overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [vault, setVault] = useState<string[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [o, b, u, v] = await Promise.all([
      api<Overview>("/api/overview"),
      api<Backup[]>("/api/backups"),
      api<User[]>("/api/users"),
      api<string[]>("/api/vault"),
    ]);
    setOverview(o);
    setBackups(b);
    setUsers(u);
    setVault(v);
  }
  useEffect(() => {
    void work(async () => {
      const status = await api<{ initialized: boolean }>("/api/status");
      setInitialized(status.initialized);
      if (status.initialized) {
        try {
          setUser(await api<User>("/api/me"));
        } catch {
          setUser(null);
        }
      }
    });
  }, []);
  useEffect(() => {
    if (user?.admin) void work(refresh);
  }, [user?.id]);
  async function createBackup(destination: string) {
    await work(async () => {
      const result = await api<{ name: string; warning: string | null }>(
        "/api/backups",
        { destination },
      );
      await refresh();
      setNotice(result.warning ?? `Backup saved: ${result.name}`);
    });
  }
  const messages = (
    <div aria-live="polite">
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="message">{notice}</div>}
    </div>
  );
  if (initialized === null)
    return (
      <main className="loading">
        <Logo />
        <p>{error || "Connecting to your companion…"}</p>
      </main>
    );

  if (!initialized)
    return (
      <SetupWizard
        onComplete={() => {
          setInitialized(true);
          setNotice("Setup complete. Sign in to continue.");
        }}
      />
    );

  if (!user)
    return (
      <div className="welcome">
        <div className="welcome-story">
          <div className="brand">
            <Logo /> talos companion
          </div>
          <div>
            <span className="eyebrow">A SMALL HOME FOR IMPORTANT THINGS</span>
            <h1>
              Your infrastructure.
              <br />
              <em>Your identity.</em>
              <br />
              Your peace of mind.
            </h1>
            <p>
              Accounts and recovery for Talos Omni.
              <br />
              Simple to run. Ready when you need it.
            </p>
            <div className="orbit" aria-hidden="true">
              <span>✳</span>
              <i />
              <b>OMNI</b>
            </div>
          </div>
          <footer>
            SELF-HOSTED BY YOU <span>RUST + REACT</span>
          </footer>
        </div>
        <main className="welcome-form">
          <div className="onboarding">
            <span className="eyebrow">WELCOME BACK</span>
            <h2>Sign in to your companion</h2>
            <p className="muted">Use your companion account to continue.</p>
            {messages}
            <fieldset disabled={busy}>
              <form
                onSubmit={(e) => {
                  const data = fields(e);
                  void work(async () => {
                    const u = await api<User>("/api/login", data);
                    const next = new URLSearchParams(location.search).get(
                      "next",
                    );
                    if (next?.startsWith("/oauth/authorize?"))
                      location.assign(next);
                    else setUser(u);
                  });
                }}
              >
                <Input
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="username"
                />
                <Input
                  label="Password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                />
                <button className="primary wide">
                  {busy ? "Signing in…" : "Sign in →"}
                </button>
              </form>
            </fieldset>
            <details>
              <summary>Forgot the administrator password?</summary>
              <p className="hint">
                The server owner can recover access without losing accounts,
                identity or backups. In Unraid’s terminal, run:
              </p>
              <pre className="recovery-command">
                <code>
                  docker exec talos-companion /talos-companion
                  --generate-password-reset-code
                </code>
              </pre>
              <p className="hint">
                This prints a single-use recovery code, valid for 15 minutes.
                Your current password keeps working until you finish below. The
                code cannot sign in to Companion or Omni. Keep the terminal
                output private. Only someone with server access can generate it.
              </p>
              <fieldset disabled={busy}>
                <form
                  onSubmit={(e) => {
                    const form = e.currentTarget;
                    const data = fields(e);
                    void work(async () => {
                      if (data["password"] !== data["confirmation"])
                        throw new Error(
                          "New password confirmation does not match.",
                        );
                      await api("/api/password/recover", data);
                      form.reset();
                      setNotice(
                        "Password updated. Your recovery code has been used. Sign in with your new password.",
                      );
                    });
                  }}
                >
                  <Input
                    label="Administrator email"
                    name="email"
                    type="email"
                    autoComplete="username"
                  />
                  <Input
                    label="Recovery code from server"
                    name="code"
                    type="password"
                    autoComplete="off"
                  />
                  <Input
                    label="New password"
                    name="password"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                  />
                  <Input
                    label="Confirm new password"
                    name="confirmation"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                  />
                  <button className="primary wide">
                    Reset password using recovery code
                  </button>
                </form>
              </fieldset>
              <a
                href="https://github.com/holblin/talos-companion/blob/main/docs/home-setup.md#recover-a-forgotten-administrator-password"
                target="_blank"
                rel="noreferrer"
              >
                Recovery instructions ↗
              </a>
            </details>
          </div>
        </main>
      </div>
    );

  const titles: Record<View, string> = {
    Overview: "Everything in its place.",
    Backups: "A way back, always.",
    Identity: "One identity. Your Omni.",
    Accounts: "The people you trust.",
    Settings: "Make yourself at home.",
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div>
            talos<span>companion</span>
          </div>
        </div>
        <div className="workspace">
          <span className="dot" />
          <div>
            My infrastructure<small>SELF-HOSTED WORKSPACE</small>
          </div>
        </div>
        <nav>
          {views
            .filter((v) => user.admin || v === "Settings")
            .map((v) => (
              <button
                key={v}
                className={view === v ? "selected" : ""}
                onClick={() => {
                  setView(v);
                }}
              >
                <span>{symbols[views.indexOf(v)]}</span>
                {v}
                {v === "Backups" && <small>{backups.length}</small>}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="status">
            <span className="dot" /> All yours. All local.
          </div>
          <button
            className="profile"
            onClick={() =>
              void work(async () => {
                await api("/api/logout", {});
                setUser(null);
                setOverview(null);
              })
            }
          >
            <span className="avatar">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              {user.name}
              <small>
                {user.admin ? "Administrator" : "Member"} · Sign out
              </small>
            </div>
            <span>↗</span>
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            Workspace <b>/</b> {view}
          </span>
          <span className="pill">◉ Companion online</span>
        </header>
        <div className="content">
          <div className="page-title">
            <div>
              <span className="eyebrow">YOUR TALOS COMPANION</span>
              <h1>{user.admin ? titles[view] : "Your account."}</h1>
              <p className="muted">
                {view === "Overview"
                  ? "A little clarity for the infrastructure you call home."
                  : "Identity and recovery, under your control."}
              </p>
            </div>
            {user.admin && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void createBackup("local")}
              >
                ＋ Create backup
              </button>
            )}
          </div>
          {messages}
          <fieldset disabled={busy}>
            {user.admin && view === "Overview" && (
              <>
                <div className="metrics">
                  <Card>
                    <span className="metric-icon">◎</span>
                    <span className="eyebrow">IDENTITY PROVIDER</span>
                    <strong>
                      {overview?.redirect_uri ? "Configured" : "Needs setup"}
                    </strong>
                    <small>OpenID Connect · RS256</small>
                  </Card>
                  <Card>
                    <span className="metric-icon">↗</span>
                    <span className="eyebrow">RECOVERY FILES</span>
                    <strong>
                      {backups.length.toString().padStart(2, "0")}{" "}
                      <i>backups</i>
                    </strong>
                    <small>Encrypted, including credentials</small>
                  </Card>
                  <Card>
                    <span className="metric-icon">⊞</span>
                    <span className="eyebrow">YOUR PEOPLE</span>
                    <strong>
                      {users.length.toString().padStart(2, "0")} <i>accounts</i>
                    </strong>
                    <small>Managed on your own terms</small>
                  </Card>
                </div>
                <div className="overview-grid">
                  <Card
                    className="recovery-card"
                    eyebrow="A LITTLE PREPARATION GOES A LONG WAY"
                    title="Keep a way back."
                  >
                    <p>
                      Your accounts, identity keys, integration credentials, and
                      received Omni backups. Together in one encrypted recovery
                      file.
                    </p>
                    <button
                      className="primary"
                      onClick={() => {
                        setView("Backups");
                      }}
                    >
                      Manage your backups ↗
                    </button>
                    <div className="recovery-art" aria-hidden="true">
                      ↶
                    </div>
                  </Card>
                  <Card
                    eyebrow="CONNECTED SERVICES"
                    title="Your infrastructure"
                  >
                    <div className="service">
                      <span className="service-logo">O</span>
                      <div>
                        <b>Talos Omni</b>
                        <small>OIDC identity + S3 backup receiver</small>
                      </div>
                      <span className="badge">
                        {overview?.redirect_uri ? "Configured" : "Set up"}
                      </span>
                    </div>
                    <div className="service">
                      <span className="service-logo">G</span>
                      <div>
                        <b>Google Drive</b>
                        <small>Off-site encrypted recovery files</small>
                      </div>
                      <span className="badge">
                        {overview?.drive.connected
                          ? "Connected"
                          : "Not connected"}
                      </span>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => {
                        setView("Identity");
                      }}
                    >
                      Connection settings →
                    </button>
                  </Card>
                </div>
                <Card title="Recent recovery files">
                  <BackupTable backups={backups.slice(0, 3)} />
                </Card>
                <div className="footnote">
                  ✳ Small footprint. Important job.{" "}
                  <span>Built for your homelab.</span>
                </div>
              </>
            )}
            {user.admin && view === "Backups" && (
              <>
                <div className="three-cols">
                  <Card eyebrow="ON THIS SERVER" title="Local storage">
                    <p>
                      Save an encrypted recovery file in the persistent data
                      directory. Download it whenever you need it.
                    </p>
                    <button onClick={() => void createBackup("local")}>
                      Create local backup →
                    </button>
                  </Card>
                  <Card eyebrow="OFF-SITE" title="Google Drive">
                    <p>
                      Send an encrypted copy to your Google Drive folder. A
                      local copy is always kept too.
                    </p>
                    <button
                      disabled={!overview?.drive.connected}
                      onClick={() => void createBackup("drive")}
                    >
                      Back up to Drive →
                    </button>
                  </Card>
                  <Card eyebrow="ON YOUR NETWORK" title="NFS / SMB">
                    <p>
                      Write a copy to a share mounted by Unraid and passed into
                      the container.
                    </p>
                    <button
                      disabled={!overview?.mounted}
                      onClick={() => void createBackup("mounted")}
                    >
                      Back up to share →
                    </button>
                  </Card>
                </div>
                <Card title="Your recovery files">
                  <BackupTable backups={backups} />
                  <p className="hint">
                    Recovery files contain password hashes and identity keys.
                    Encryption uses your BACKUP_PASSPHRASE. Recovery files
                    stream without a fixed size cap. Retention:{" "}
                    {overview?.retention.recovery_keep_last
                      ? `newest ${String(overview.retention.recovery_keep_last)} recovery files per destination`
                      : "all recovery files"}
                    {"; "}
                    {overview?.retention.snapshot_keep_last
                      ? `newest ${String(overview.retention.snapshot_keep_last)} Omni snapshots per cluster`
                      : "all received Omni snapshots"}
                    .
                  </p>
                </Card>
                <Card title="Omni credentials and recovery material">
                  <p>
                    Add your Omni configuration, encryption keys, or other
                    recovery files here. These files stay private to
                    administrators and are included in encrypted recovery
                    backups.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const data = new FormData(form);
                      void work(async () => {
                        await api("/api/vault", data);
                        form.reset();
                        await refresh();
                        setNotice(
                          "Credential file saved. Create a backup to include it in a recovery file.",
                        );
                      });
                    }}
                  >
                    <label className="field">
                      <span>Credential file (up to 16 MiB)</span>
                      <input type="file" name="file" required />
                    </label>
                    <button>Save credential file →</button>
                  </form>
                  {vault.map((name) => (
                    <div className="account" key={name}>
                      <code>{name}</code>
                      <a
                        className="download"
                        href={`/api/vault/${encodeURIComponent(name)}`}
                      >
                        Download ↓
                      </a>
                      <button
                        className="text-button danger"
                        onClick={() => {
                          if (
                            confirm(
                              `Remove ${name} from live storage? Existing recovery files will retain it.`,
                            )
                          )
                            void work(async () => {
                              await api(
                                `/api/vault/${encodeURIComponent(name)}`,
                                undefined,
                                "DELETE",
                              );
                              await refresh();
                            });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <p className="hint">
                    Uploading a file with the same name replaces the previous
                    version. Companion does not automatically collect Omni’s own
                    database or encryption material.
                  </p>
                </Card>
                <Card title="Restore on a fresh instance">
                  <p>
                    Start a new container with an empty data directory. Choose
                    “Restore a backup” on the first-launch screen. Supply your
                    original passphrase, and optionally replace the first
                    administrator’s credentials.
                  </p>
                  <p className="hint">
                    Cluster backups received over S3 are separate from Omni’s
                    own database and encryption-key backups. Include those
                    separately using the documented recovery procedure.
                  </p>
                </Card>
              </>
            )}
            {user.admin && view === "Identity" && overview && (
              <>
                <OmniSetup />
                <div className="two-cols">
                  <Card
                    eyebrow="OPENID CONNECT"
                    title="Give Omni a familiar face"
                  >
                    <p>
                      Your companion is a dedicated identity provider for one
                      Omni instance. Add Omni’s exact callback URL, then
                      configure Omni with these values.
                    </p>
                    <dl>
                      <dt>Issuer URL</dt>
                      <dd>
                        <code>{overview.issuer}</code>
                      </dd>
                      <dt>Client ID</dt>
                      <dd>
                        <code>{overview.client_id}</code>
                      </dd>
                    </dl>
                    <Secret
                      label="Client secret"
                      value={overview.client_secret}
                    />
                    <form
                      onSubmit={(e) => {
                        const data = fields(e);
                        void work(async () => {
                          await api("/api/oidc", data);
                          await refresh();
                          setNotice("Omni callback URL saved.");
                        });
                      }}
                    >
                      <Input
                        label="Omni callback URL"
                        name="redirect_uri"
                        type="url"
                        placeholder="https://omni.example.com/oidc/consume"
                        defaultValue={overview.redirect_uri}
                      />
                      <button className="primary">Save callback URL</button>
                    </form>
                  </Card>
                  <Card
                    eyebrow="S3-COMPATIBLE RECEIVER"
                    title="A home for Omni backups"
                  >
                    <p>
                      Point Omni’s S3 backup configuration to this server on
                      port 9000. The bucket is created automatically after
                      account setup.
                    </p>
                    <dl>
                      <dt>Bucket</dt>
                      <dd>
                        <code>omni</code>
                      </dd>
                      <dt>Region</dt>
                      <dd>
                        <code>us-east-1</code>
                      </dd>
                      <dt>Endpoint</dt>
                      <dd>Your server’s reachable address, port 9000</dd>
                    </dl>
                    <Secret label="Access key" value={overview.s3_access_key} />
                    <Secret label="Secret key" value={overview.s3_secret_key} />
                    <p className="hint">
                      Configure Omni with S3 backups enabled. See docs/omni.md
                      for the resource template and full setup instructions.
                      Omni access roles are managed in Omni.
                    </p>
                  </Card>
                </div>
              </>
            )}
            {user.admin && view === "Accounts" && (
              <div className="two-cols">
                <Card title="Workspace accounts">
                  <div className="account-list">
                    {users.map((u) => (
                      <div className="account" key={u.id}>
                        <span className="avatar">{u.name.slice(0, 1)}</span>
                        <div>
                          <b>{u.name}</b>
                          <small>
                            {u.email} · {u.admin ? "Administrator" : "Member"}
                          </small>
                        </div>
                        {u.id !== user.id && (
                          <button
                            className="text-button danger"
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove ${u.email}? This revokes their companion sessions and future Omni sign-ins.`,
                                )
                              )
                                void work(async () => {
                                  await api(
                                    `/api/users/${u.id}`,
                                    undefined,
                                    "DELETE",
                                  );
                                  await refresh();
                                });
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="hint">
                    Administrators can manage identity settings, people, and
                    backups. Members can sign in to Omni and change their own
                    password. Adding an email here is an administrator’s
                    assertion that it belongs to that person.
                  </p>
                </Card>
                <Card title="Invite someone in">
                  <form
                    onSubmit={(e) => {
                      const form = e.currentTarget;
                      const data = fields(e);
                      void work(async () => {
                        await api("/api/users", {
                          ...data,
                          admin: data["admin"] === "on",
                        });
                        form.reset();
                        await refresh();
                        setNotice(
                          "Account created. Share the credentials with the account holder securely.",
                        );
                      });
                    }}
                  >
                    <AccountFields />
                    <label className="check">
                      <input name="admin" type="checkbox" /> Administrator
                      access
                    </label>
                    <button className="primary">Create account</button>
                  </form>
                </Card>
              </div>
            )}
            {(view === "Settings" || !user.admin) && (
              <div className="two-cols">
                {user.admin && overview && (
                  <Card title="Backup settings">
                    <form
                      key={JSON.stringify(overview.settings)}
                      onSubmit={(e) => {
                        const data = fields(e);
                        void work(async () => {
                          await api("/api/settings", {
                            retention: {
                              recovery_keep_last: Number(
                                data["recovery_keep_last"],
                              ),
                              snapshot_keep_last: Number(
                                data["snapshot_keep_last"],
                              ),
                            },
                            schedule: {
                              enabled: data["enabled"] === "on",
                              interval_seconds: Number(
                                data["interval_seconds"],
                              ),
                              destination: data["destination"],
                            },
                          });
                          await refresh();
                          setNotice("Backup settings saved and applied.");
                        });
                      }}
                    >
                      <Input
                        label="Recovery files to keep per destination"
                        name="recovery_keep_last"
                        type="number"
                        min={0}
                        max={1000000}
                        step={1}
                        defaultValue={
                          overview.settings.retention.recovery_keep_last
                        }
                      />
                      <Input
                        label="Omni snapshots to keep per cluster"
                        name="snapshot_keep_last"
                        type="number"
                        min={0}
                        max={1000000}
                        step={1}
                        defaultValue={
                          overview.settings.retention.snapshot_keep_last
                        }
                      />
                      <p className="hint">
                        Use 0 to keep everything. Retention applies after the
                        next successful backup.
                      </p>
                      <label className="check">
                        <input
                          name="enabled"
                          type="checkbox"
                          defaultChecked={overview.settings.schedule.enabled}
                        />
                        Enable scheduled backups
                      </label>
                      <Input
                        label="Backup interval (seconds)"
                        name="interval_seconds"
                        type="number"
                        min={60}
                        max={31536000}
                        step={1}
                        defaultValue={
                          overview.settings.schedule.interval_seconds
                        }
                      />
                      <p className="hint">
                        3600 = hourly · 86400 = daily. Saving resets the
                        schedule timer.
                      </p>
                      <label className="field">
                        <span>Scheduled destination</span>
                        <select
                          name="destination"
                          defaultValue={overview.settings.schedule.destination}
                        >
                          <option value="local">Local storage</option>
                          <option value="mounted" disabled={!overview.mounted}>
                            Mounted NFS / SMB
                          </option>
                          <option
                            value="drive"
                            disabled={!overview.drive.connected}
                          >
                            Google Drive
                          </option>
                        </select>
                      </label>
                      <button className="primary">Save backup settings</button>
                    </form>
                    <p className="hint">
                      Saved in /data/config.json and included in recovery
                      backups. Changes apply immediately. An active backup
                      finishes with its original settings.
                    </p>
                  </Card>
                )}
                <Card title="Change your password">
                  <form
                    onSubmit={(e) => {
                      const data = fields(e);
                      void work(async () => {
                        await api("/api/password", data);
                        setUser(null);
                        setNotice("Password updated. Sign in again.");
                      });
                    }}
                  >
                    <Input
                      label="Current password"
                      name="current"
                      type="password"
                      autoComplete="current-password"
                    />
                    <Input
                      label="New password"
                      name="password"
                      type="password"
                      minLength={12}
                      autoComplete="new-password"
                    />
                    <button className="primary">Update password</button>
                  </form>
                  <p className="hint">
                    Changing your password signs you out of all companion
                    sessions.
                  </p>
                </Card>
                {user.admin && (
                  <Card title="Connect Google Drive">
                    <p>
                      Create a Google OAuth web client with the Drive API
                      enabled. Register this callback URL:
                    </p>
                    <code className="block">
                      {overview?.issuer}/oauth/google/callback
                    </code>
                    <form
                      onSubmit={(e) => {
                        const data = fields(e);
                        void work(async () => {
                          await api("/api/drive", data);
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
                        defaultValue={overview?.drive.client_id ?? ""}
                      />
                      <Input
                        label="Google client secret"
                        name="client_secret"
                        type="password"
                      />
                      <Input
                        label="Destination folder ID (optional)"
                        name="folder_id"
                        required={false}
                        placeholder="Leave empty to create a dedicated folder"
                        defaultValue={overview?.drive.folder_id ?? ""}
                      />
                      <button className="primary">
                        Save and authorize Google Drive ↗
                      </button>
                    </form>
                    <p className="hint">
                      Leave the folder ID empty to create a dedicated folder.
                      Uses the drive.file scope. Testing-mode Google grants may
                      expire after seven days; see docs/google-drive.md.
                    </p>
                  </Card>
                )}
              </div>
            )}
          </fieldset>
        </div>
      </main>
    </div>
  );
}
function BackupTable({ backups }: { backups: Backup[] }) {
  return backups.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>RECOVERY FILE</th>
            <th>SIZE</th>
            <th>PROTECTION</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {backups.map((b) => (
            <tr key={b.name}>
              <td>
                <span className="file-icon">▤</span>
                <code>{b.name}</code>
              </td>
              <td>{(b.bytes / 1024 / 1024).toFixed(2)} MB</td>
              <td>
                <span className="badge">◈ Encrypted</span>
              </td>
              <td>
                <a
                  className="download"
                  href={`/api/backups/${encodeURIComponent(b.name)}`}
                >
                  Download ↓
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <span>↶</span>
      <h3>Your first backup starts here.</h3>
      <p>
        Create a recovery file to keep your accounts and infrastructure safe.
      </p>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("The application root element is missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
