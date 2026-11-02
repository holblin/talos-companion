import { useEffect, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { api } from "./api";
import RecoveryPassphrase from "./RecoveryPassphrase";

type Settings = {
  retention: { recovery_keep_last: number; snapshot_keep_last: number };
  schedule: { enabled: boolean; interval_seconds: number; destination: string };
};
type Deployment = {
  backup_passphrase: string;
  public_url: string;
  mounted: string | null;
  settings: Settings;
};
function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input required {...props} />
    </label>
  );
}
export default function SetupWizard({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [step, setStep] = useState(0);
  const [token, setToken] = useState("");
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [account, setAccount] = useState({ name: "", email: "", password: "" });
  const [confirmation, setConfirmation] = useState("");
  const [override, setOverride] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedPassphrase, setSavedPassphrase] = useState(false);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const labels =
    mode === "create"
      ? ["Welcome", "Access", "Administrator", "Backups", "Review", "Ready"]
      : ["Welcome", "Access", "Recovery", "Review", "Ready"];
  const last = labels.length - 1;
  const reviewing = step === last - 1;
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const setAccountField = (name: keyof typeof account, value: string) => {
    setAccount({ ...account, [name]: value });
  };
  async function next() {
    setError("");
    setBusy(true);
    try {
      if (step === 1) {
        const result = await api<Deployment>("/api/setup/check", {}, "POST", {
          "x-setup-token": token,
        });
        setDeployment(result);
        setSettings(result.settings);
        setSavedPassphrase(false);
        setRecoveryConfirmation("");
      }
      if (step === 2) {
        if (mode === "restore" && !file)
          throw new Error(
            "Choose the encrypted .tcb recovery file to continue.",
          );
        if (
          (mode === "create" || override) &&
          account.password !== confirmation
        )
          throw new Error(
            "The passwords do not match. Enter them again to confirm.",
          );
      }
      if (reviewing) {
        if (
          !savedPassphrase ||
          !deployment ||
          recoveryConfirmation !== deployment.backup_passphrase
        ) {
          throw new Error(
            "Save your backup passphrase and re-enter it to confirm. Uncheck the box to see the original again.",
          );
        }
        if (mode === "create") {
          await api(
            "/api/setup",
            {
              ...account,
              settings,
              backup_passphrase_confirmation: recoveryConfirmation,
            },
            "POST",
            {
              "x-setup-token": token,
            },
          );
        } else {
          if (!file)
            throw new Error("Choose a recovery file before restoring.");
          const payload = new FormData();
          payload.append("file", file);
          payload.append("passphrase", passphrase);
          payload.append(
            "backup_passphrase_confirmation",
            recoveryConfirmation,
          );
          if (override) payload.append("account", JSON.stringify(account));
          await api("/api/restore", payload, "POST", {
            "x-setup-token": token,
          });
        }
        setToken("");
        setPassphrase("");
        setAccount({ ...account, password: "" });
        setConfirmation("");
        setFile(null);
        setDeployment(null);
        setRecoveryConfirmation("");
      }
      setStep(step + 1);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Setup could not continue. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const accountFields = (
    <>
      <Field
        label="Display name"
        name="name"
        autoComplete="name"
        maxLength={100}
        value={account.name}
        onChange={(e) => {
          setAccountField("name", e.target.value);
        }}
      />
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="username"
        maxLength={254}
        value={account.email}
        onChange={(e) => {
          setAccountField("email", e.target.value);
        }}
      />
      <Field
        label="Password (at least 12 characters)"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        maxLength={256}
        value={account.password}
        onChange={(e) => {
          setAccountField("password", e.target.value);
        }}
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        value={confirmation}
        onChange={(e) => {
          setConfirmation(e.target.value);
        }}
      />
    </>
  );
  return (
    <div className="wizard-page">
      <main className="wizard">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            T<span>+</span>
          </span>{" "}
          talos companion
        </div>
        <p className="eyebrow">
          FIRST-TIME SETUP · STEP {step + 1} OF {labels.length}
        </p>
        <ol className="wizard-progress" aria-label="Setup progress">
          {labels.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={i < step ? "done" : ""}
            >
              <span>{i < step ? "✓" : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <h1 ref={heading} tabIndex={-1}>
          {
            [
              "Welcome to your companion.",
              "Confirm access to this installation.",
              mode === "create"
                ? "Create your administrator."
                : "Choose your recovery file.",
              ...(mode === "create" ? ["Choose your backup routine."] : []),
              "Review and finish.",
              "Your companion is ready.",
            ][step]
          }
        </h1>
        <div aria-live="polite">
          {error && (
            <div className="message error" role="alert">
              {error}
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void next();
          }}
        >
          <fieldset disabled={busy} aria-busy={busy}>
            {step === 0 && (
              <>
                <p>
                  Keep your Talos Omni sign-in, accounts, credentials, and
                  recovery files together on your own server. We’ll guide you
                  through the essentials.
                </p>
                <div className="wizard-choices">
                  <label>
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === "create"}
                      onChange={() => {
                        setMode("create");
                      }}
                    />
                    <strong>Start a new installation</strong>
                    <span>
                      Create an administrator and choose your backup routine.
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === "restore"}
                      onChange={() => {
                        setMode("restore");
                      }}
                    />
                    <strong>Restore an existing companion</strong>
                    <span>
                      Recover accounts, identity keys, credentials, Omni
                      snapshots, and settings from a .tcb file.
                    </span>
                  </label>
                </div>
                <div className="wizard-note">
                  <strong>Have these ready</strong>
                  <ul>
                    <li>
                      Your setup token from the Unraid container template or
                      Docker .env file.
                    </li>
                    <li>
                      {mode === "create"
                        ? "A password for your new administrator."
                        : "Your encrypted .tcb recovery file and its original backup passphrase."}
                    </li>
                    <li>
                      A safe place outside this server for your backup
                      passphrase.
                    </li>
                  </ul>
                </div>
                <p className="hint">
                  Omni and Google Drive connections can be completed after
                  setup. You don’t need either to get started.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <p>
                  The setup token confirms you can administer this server. It is
                  separate from your account password and backup passphrase.
                </p>
                <Field
                  label="Setup token"
                  name="setup_token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                  }}
                />
                <p className="hint">
                  Find SETUP_TOKEN in your Unraid container settings or Docker
                  .env file. If no override was supplied, find the generated
                  token in the container's first-start logs or its private
                  /data/setup-token file.
                </p>
                <div className="wizard-note">
                  <strong>Before continuing</strong>
                  <p>
                    Use the address you intend to keep for this companion. Omni
                    will use the configured public address to identify your
                    sign-in provider. Store backups and the encryption
                    passphrase separately from this server.
                  </p>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                {mode === "create" ? (
                  <>
                    <p>
                      This account manages other users, Omni sign-in,
                      credentials, and backups. Public registration is disabled.
                    </p>
                    {accountFields}
                    <p className="hint">
                      Choose an email you control. No verification email will be
                      sent.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Choose a version 2 companion recovery file. The entire
                      encrypted file is checked before accounts or data are
                      replaced.
                    </p>
                    <label className="field">
                      <span>Encrypted recovery file (.tcb)</span>
                      <input
                        type="file"
                        accept=".tcb"
                        onChange={(e) => {
                          setFile(e.target.files?.[0] ?? null);
                        }}
                        required={!file}
                      />
                    </label>
                    {file && (
                      <p className="hint">
                        Selected: {file.name} ·{" "}
                        {(file.size / 1024 / 1024).toFixed(2)} MiB
                      </p>
                    )}
                    <Field
                      label="Original backup passphrase"
                      name="passphrase"
                      type="password"
                      autoComplete="off"
                      value={passphrase}
                      onChange={(e) => {
                        setPassphrase(e.target.value);
                      }}
                    />
                    <p className="hint">
                      Use the passphrase from when this backup was created. It
                      may differ from the passphrase configured on this
                      replacement server.
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={override}
                        onChange={(e) => {
                          setOverride(e.target.checked);
                        }}
                      />
                      Replace the first administrator’s login details
                    </label>
                    {override ? (
                      <>
                        <p className="hint">
                          Useful if you’ve lost the original login. The
                          administrator’s identity ID and all other accounts are
                          preserved.
                        </p>
                        {accountFields}
                      </>
                    ) : (
                      <p className="hint">
                        You’ll sign in with an administrator account from the
                        backup.
                      </p>
                    )}
                    <p className="hint">
                      Large restores can take several minutes. Keep this page
                      open. The server needs space for both the upload and its
                      extracted contents.
                    </p>
                  </>
                )}
              </>
            )}
            {mode === "create" && step === 3 && settings && (
              <>
                <p>
                  Start with daily encrypted backups to local storage, or choose
                  a mounted destination. You can change all of these later in
                  Settings.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.schedule.enabled}
                    onChange={(e) => {
                      setSettings({
                        ...settings,
                        schedule: {
                          ...settings.schedule,
                          enabled: e.target.checked,
                        },
                      });
                    }}
                  />
                  Enable scheduled backups
                </label>
                <label className="field">
                  <span>Backup frequency</span>
                  <select
                    value={settings.schedule.interval_seconds}
                    onChange={(e) => {
                      setSettings({
                        ...settings,
                        schedule: {
                          ...settings.schedule,
                          interval_seconds: Number(e.target.value),
                        },
                      });
                    }}
                  >
                    {![3600, 21600, 86400, 604800].includes(
                      settings.schedule.interval_seconds,
                    ) && (
                      <option value={settings.schedule.interval_seconds}>
                        Every {settings.schedule.interval_seconds} seconds
                      </option>
                    )}
                    <option value={3600}>Every hour</option>
                    <option value={21600}>Every 6 hours</option>
                    <option value={86400}>Every day</option>
                    <option value={604800}>Every week</option>
                  </select>
                </label>
                <label className="field">
                  <span>Scheduled destination</span>
                  <select
                    value={settings.schedule.destination}
                    onChange={(e) => {
                      setSettings({
                        ...settings,
                        schedule: {
                          ...settings.schedule,
                          destination: e.target.value,
                        },
                      });
                    }}
                  >
                    <option value="local">Local storage</option>
                    <option value="mounted" disabled={!deployment?.mounted}>
                      Mounted NFS / SMB
                    </option>
                  </select>
                </label>
                <p className="hint">
                  Local backups are stored in /data/backups.{" "}
                  {deployment?.mounted
                    ? `Mounted destination: ${deployment.mounted}.`
                    : "To use NFS / SMB, mount the share in Unraid and map it into the container."}{" "}
                  Google Drive can be connected after sign-in.
                </p>
                <Field
                  label="Recovery files to keep per destination"
                  type="number"
                  min={0}
                  max={1000000}
                  step={1}
                  value={settings.retention.recovery_keep_last}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      retention: {
                        ...settings.retention,
                        recovery_keep_last: Number(e.target.value),
                      },
                    });
                  }}
                />
                <Field
                  label="Omni snapshots to keep per cluster"
                  type="number"
                  min={0}
                  max={1000000}
                  step={1}
                  value={settings.retention.snapshot_keep_last}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      retention: {
                        ...settings.retention,
                        snapshot_keep_last: Number(e.target.value),
                      },
                    });
                  }}
                />
                <p className="hint">
                  0 keeps everything. Old files are pruned only after a
                  successful backup. Local storage alone won’t protect against
                  losing this server.
                </p>
              </>
            )}
            {reviewing && (
              <>
                <p>
                  Review these details before{" "}
                  {mode === "create"
                    ? "creating your installation"
                    : "restoring your companion"}
                  . Save and verify the recovery details below before
                  continuing.
                </p>
                <dl className="wizard-review">
                  <dt>Public address / OIDC issuer</dt>
                  <dd>{deployment?.public_url}</dd>
                  <dt>Installation</dt>
                  <dd>
                    {mode === "create"
                      ? "New companion"
                      : `Restore ${file?.name ?? "selected backup"}`}
                  </dd>
                  <dt>Administrator</dt>
                  <dd>
                    {mode === "create" || override
                      ? `${account.name} · ${account.email}`
                      : "Keep the accounts from the backup"}
                  </dd>
                  <dt>Backups</dt>
                  <dd>
                    {mode === "restore"
                      ? "Restore the saved schedule and retention settings"
                      : settings?.schedule.enabled
                        ? `Every ${String(settings.schedule.interval_seconds / 3600)} hours → ${settings.schedule.destination}`
                        : "Scheduled backups disabled"}
                  </dd>
                  {mode === "create" && (
                    <>
                      <dt>Retention</dt>
                      <dd>
                        {settings?.retention.recovery_keep_last || "Unlimited"}{" "}
                        recovery files per destination;{" "}
                        {settings?.retention.snapshot_keep_last || "unlimited"}{" "}
                        Omni snapshots per cluster
                      </dd>
                    </>
                  )}
                </dl>
                {deployment?.public_url.startsWith("http:") && (
                  <p className="hint">
                    The public address uses HTTP. For access outside your
                    trusted local network, configure HTTPS at your reverse proxy
                    and update PUBLIC_URL before connecting Omni.
                  </p>
                )}
                {deployment && (
                  <RecoveryPassphrase
                    passphrase={deployment.backup_passphrase}
                    issuer={deployment.public_url}
                    setupToken={token}
                    saved={savedPassphrase}
                    confirmation={recoveryConfirmation}
                    onSaved={setSavedPassphrase}
                    onConfirmation={setRecoveryConfirmation}
                  />
                )}
                <p className="hint">
                  {mode === "restore"
                    ? "Recovered identities and integration credentials are preserved. Recheck external destinations on this replacement server after sign-in."
                    : settings?.schedule.enabled
                      ? "Your first scheduled backup runs after the chosen interval. You can create one immediately after sign-in."
                      : "Scheduled backups are disabled. You can create a backup manually after sign-in or enable a schedule in Settings."}
                </p>
              </>
            )}
            {step === last && (
              <>
                <p>
                  {mode === "create"
                    ? "Your administrator and backup settings are saved."
                    : "Your accounts, credentials, and backup configuration have been restored."}{" "}
                  Sign in to finish connecting your infrastructure.
                </p>
                <ol className="wizard-next">
                  <li>
                    <strong>Connect Talos Omni</strong>
                    <span>
                      Open Identity, register Omni’s callback URL, and copy the
                      OIDC and S3 connection details into Omni.
                    </span>
                  </li>
                  <li>
                    <strong>Check your backup destination</strong>
                    <span>
                      Open Settings to connect Google Drive or review your
                      schedule. Confirm any NFS / SMB share is mounted on this
                      host.
                    </span>
                  </li>
                  <li>
                    <strong>Make your first backup</strong>
                    <span>
                      Upload any Omni encryption keys or configuration to the
                      credential vault in Backups, then create and download an
                      encrypted recovery file.
                    </span>
                  </li>
                </ol>
                <p className="hint">
                  {mode === "restore" && !override
                    ? "Use an administrator login from your backup."
                    : `Sign in as ${account.email}.`}{" "}
                  Keep your backup passphrase separate from the recovery file.
                  Future backups use the passphrase configured on this server.
                </p>
              </>
            )}
            {busy && (
              <p className="message" role="status">
                {reviewing
                  ? mode === "restore"
                    ? "Uploading, decrypting, and validating your recovery file. Keep this page open…"
                    : "Creating your administrator and identity keys…"
                  : "Checking your setup token…"}
              </p>
            )}
            <div className="wizard-actions">
              {step > 0 && step < last && (
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    setStep(step - 1);
                  }}
                >
                  ← Back
                </button>
              )}
              {step === last ? (
                <button type="button" className="primary" onClick={onComplete}>
                  Continue to sign in →
                </button>
              ) : (
                <button className="primary">
                  {busy
                    ? "Please wait…"
                    : reviewing
                      ? mode === "create"
                        ? "Create companion"
                        : "Restore companion"
                      : "Continue →"}
                </button>
              )}
            </div>
          </fieldset>
        </form>
      </main>
    </div>
  );
}
