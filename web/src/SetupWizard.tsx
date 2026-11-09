import { documentClass } from "./layout";
import FilePicker from "./FilePicker";
import { useTask } from "./useTask";
import { classes, layout } from "./layout";
import Field from "./Field";
import { RadioGroup, Radio } from "@react-spectrum/s2/RadioGroup";
import { Form } from "@react-spectrum/s2/Form";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { Picker, PickerItem } from "@react-spectrum/s2/Picker";
import { Button } from "@react-spectrum/s2/Button";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useEffect, useRef, useState } from "react";

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
  const { busy, error, setError, work } = useTask();
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
    await work(async () => {
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
    });
  }
  const accountFields = (
    <>
      <Field
        label="Display name"
        name="name"
        autoComplete="name"
        maxLength={100}
        value={account.name}
        onChange={(value) => {
          setAccountField("name", value);
        }}
      />
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="username"
        maxLength={254}
        value={account.email}
        onChange={(value) => {
          setAccountField("email", value);
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
        onChange={(value) => {
          setAccountField("password", value);
        }}
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        value={confirmation}
        onChange={(value) => {
          setConfirmation(value);
        }}
      />
    </>
  );
  return (
    <div className={classes("wizard-page")}>
      <main className={classes("wizard")}>
        <div className={classes("brand")}>
          <span className={classes("logo")} aria-hidden="true">
            T<span>+</span>
          </span>{" "}
          talos companion
        </div>
        <p className={documentClass("p", classes("eyebrow"))}>
          FIRST-TIME SETUP · STEP {step + 1} OF {labels.length}
        </p>
        <ol className={classes("wizard-progress")} aria-label="Setup progress">
          {labels.map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={
                i === step
                  ? `${layout.progressStep} ${layout.progressCurrent}`
                  : layout.progressStep
              }
            >
              <span className={layout.progressNumber}>
                {i < step ? "✓" : i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <h1 className={documentClass("h1")} ref={heading} tabIndex={-1}>
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
            <div className={classes("message error")} role="alert">
              {error}
            </div>
          )}
        </div>
        <Form
          isDisabled={busy}
          onSubmit={(e) => {
            e.preventDefault();
            void next();
          }}
        >
          <fieldset
            className={documentClass("fieldset")}
            disabled={busy}
            aria-busy={busy}
          >
            {step === 0 && (
              <>
                <p className={documentClass("p")}>
                  Keep your Talos Omni sign-in, accounts, credentials, and
                  recovery files together on your own server. We’ll guide you
                  through the essentials.
                </p>
                <RadioGroup
                  label="Installation"
                  value={mode}
                  onChange={(value) => {
                    if (value === "create" || value === "restore")
                      setMode(value);
                  }}
                >
                  <Radio value="create">Start a new installation</Radio>
                  <Radio value="restore">Restore an existing companion</Radio>
                </RadioGroup>
                <p className={documentClass("p", classes("hint"))}>
                  {mode === "create"
                    ? "Create an administrator and choose your backup routine."
                    : "Recover accounts, identity keys, credentials, Omni snapshots, and settings from a .tcb file."}
                </p>
                <div className={classes("wizard-note")}>
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
                <p className={documentClass("p", classes("hint"))}>
                  Omni and Google Drive connections can be completed after
                  setup. You don’t need either to get started.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <p className={documentClass("p")}>
                  The setup token confirms you can administer this server. It is
                  separate from your account password and backup passphrase.
                </p>
                <Field
                  label="Setup token"
                  name="setup_token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(value) => {
                    setToken(value);
                  }}
                />
                <p className={documentClass("p", classes("hint"))}>
                  Find SETUP_TOKEN in your Unraid container settings or Docker
                  .env file. If no override was supplied, find the generated
                  token in the container's first-start logs or its private
                  /data/setup-token file.
                </p>
                <div className={classes("wizard-note")}>
                  <strong>Before continuing</strong>
                  <p className={documentClass("p")}>
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
                    <p className={documentClass("p")}>
                      This account manages other users, Omni sign-in,
                      credentials, and backups. Public registration is disabled.
                    </p>
                    {accountFields}
                    <p className={documentClass("p", classes("hint"))}>
                      Choose an email you control. No verification email will be
                      sent.
                    </p>
                  </>
                ) : (
                  <>
                    <p className={documentClass("p")}>
                      Choose a version 2 companion recovery file. The entire
                      encrypted file is checked before accounts or data are
                      replaced.
                    </p>
                    <FilePicker
                      label="Choose encrypted recovery file (.tcb)"
                      acceptedFileTypes={[".tcb"]}
                      file={file}
                      onChange={setFile}
                      isDisabled={busy}
                    />
                    {file && (
                      <p className={documentClass("p", classes("hint"))}>
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
                      onChange={(value) => {
                        setPassphrase(value);
                      }}
                    />
                    <p className={documentClass("p", classes("hint"))}>
                      Use the passphrase from when this backup was created. It
                      may differ from the passphrase configured on this
                      replacement server.
                    </p>
                    <Checkbox
                      isSelected={override}
                      onChange={(value) => {
                        setOverride(value);
                      }}
                      styles={style({ width: "full", marginY: 12 })}
                    >
                      Replace the first administrator’s login details
                    </Checkbox>
                    {override ? (
                      <>
                        <p className={documentClass("p", classes("hint"))}>
                          Useful if you’ve lost the original login. The
                          administrator’s identity ID and all other accounts are
                          preserved.
                        </p>
                        {accountFields}
                      </>
                    ) : (
                      <p className={documentClass("p", classes("hint"))}>
                        You’ll sign in with an administrator account from the
                        backup.
                      </p>
                    )}
                    <p className={documentClass("p", classes("hint"))}>
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
                <p className={documentClass("p")}>
                  Start with daily encrypted backups to local storage, or choose
                  a remote NFS or SMB share after sign-in. You can change all of
                  these later in Settings.
                </p>
                <Checkbox
                  isSelected={settings.schedule.enabled}
                  onChange={(value) => {
                    setSettings({
                      ...settings,
                      schedule: {
                        ...settings.schedule,
                        enabled: value,
                      },
                    });
                  }}
                  styles={style({ width: "full", marginY: 12 })}
                >
                  Enable scheduled backups
                </Checkbox>
                <Picker
                  label={<>Backup frequency</>}
                  value={settings.schedule.interval_seconds}
                  onChange={(value) => {
                    setSettings({
                      ...settings,
                      schedule: {
                        ...settings.schedule,
                        interval_seconds: Number(value),
                      },
                    });
                  }}
                  styles={style({ width: "full", marginY: 12 })}
                >
                  {![3600, 21600, 86400, 604800].includes(
                    settings.schedule.interval_seconds,
                  ) && (
                    <PickerItem id={settings.schedule.interval_seconds}>
                      Every {settings.schedule.interval_seconds} seconds
                    </PickerItem>
                  )}
                  <PickerItem id={3600}>Every hour</PickerItem>
                  <PickerItem id={21600}>Every 6 hours</PickerItem>
                  <PickerItem id={86400}>Every day</PickerItem>
                  <PickerItem id={604800}>Every week</PickerItem>
                </Picker>
                <Picker
                  label={<>Scheduled destination</>}
                  value={settings.schedule.destination}
                  onChange={(value) => {
                    setSettings({
                      ...settings,
                      schedule: {
                        ...settings.schedule,
                        destination: String(value ?? "local"),
                      },
                    });
                  }}
                  styles={style({ width: "full", marginY: 12 })}
                >
                  <PickerItem id="local">Local storage</PickerItem>
                </Picker>
                <p className={documentClass("p", classes("hint"))}>
                  Local backups are stored in /data/backups.{" "}
                  {
                    "Connect a remote NFS or SMB share from Backups after sign-in. For host or Docker mounted storage, use Local storage with the folder mapped to /data/backups."
                  }{" "}
                  Google Drive can be connected after sign-in.
                </p>
                <Field
                  label="Recovery files to keep per destination"
                  type="number"
                  min={0}
                  max={1000000}
                  step={1}
                  value={settings.retention.recovery_keep_last}
                  onChange={(value) => {
                    setSettings({
                      ...settings,
                      retention: {
                        ...settings.retention,
                        recovery_keep_last: Number(value),
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
                  onChange={(value) => {
                    setSettings({
                      ...settings,
                      retention: {
                        ...settings.retention,
                        snapshot_keep_last: Number(value),
                      },
                    });
                  }}
                />
                <p className={documentClass("p", classes("hint"))}>
                  0 keeps everything. Old files are pruned only after a
                  successful backup. Local storage alone won’t protect against
                  losing this server.
                </p>
              </>
            )}
            {reviewing && (
              <>
                <p className={documentClass("p")}>
                  Review these details before{" "}
                  {mode === "create"
                    ? "creating your installation"
                    : "restoring your companion"}
                  . Save and verify the recovery details below before
                  continuing.
                </p>
                <dl className={classes("wizard-review")}>
                  <dt className={documentClass("dt")}>
                    Public address / OIDC issuer
                  </dt>
                  <dd className={documentClass("dd")}>
                    {deployment?.public_url}
                  </dd>
                  <dt className={documentClass("dt")}>Installation</dt>
                  <dd className={documentClass("dd")}>
                    {mode === "create"
                      ? "New companion"
                      : `Restore ${file?.name ?? "selected backup"}`}
                  </dd>
                  <dt className={documentClass("dt")}>Administrator</dt>
                  <dd className={documentClass("dd")}>
                    {mode === "create" || override
                      ? `${account.name} · ${account.email}`
                      : "Keep the accounts from the backup"}
                  </dd>
                  <dt className={documentClass("dt")}>Backups</dt>
                  <dd className={documentClass("dd")}>
                    {mode === "restore"
                      ? "Restore the saved schedule and retention settings"
                      : settings?.schedule.enabled
                        ? `Every ${String(settings.schedule.interval_seconds / 3600)} hours → ${settings.schedule.destination}`
                        : "Scheduled backups disabled"}
                  </dd>
                  {mode === "create" && (
                    <>
                      <dt className={documentClass("dt")}>Retention</dt>
                      <dd className={documentClass("dd")}>
                        {settings?.retention.recovery_keep_last || "Unlimited"}{" "}
                        recovery files per destination;{" "}
                        {settings?.retention.snapshot_keep_last || "unlimited"}{" "}
                        Omni snapshots per cluster
                      </dd>
                    </>
                  )}
                </dl>
                {deployment?.public_url.startsWith("http:") && (
                  <p className={documentClass("p", classes("hint"))}>
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
                <p className={documentClass("p", classes("hint"))}>
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
                <p className={documentClass("p")}>
                  {mode === "create"
                    ? "Your administrator and backup settings are saved."
                    : "Your accounts, credentials, and backup configuration have been restored."}{" "}
                  Sign in to finish connecting your infrastructure.
                </p>
                <ol className={classes("wizard-next")}>
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
                      schedule. Reconnect any remote NFS / SMB share from
                      Backups on this host.
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
                <p className={documentClass("p", classes("hint"))}>
                  {mode === "restore" && !override
                    ? "Use an administrator login from your backup."
                    : `Sign in as ${account.email}.`}{" "}
                  Keep your backup passphrase separate from the recovery file.
                  Future backups use the passphrase configured on this server.
                </p>
              </>
            )}
            {busy && (
              <p
                className={documentClass("p", classes("message"))}
                role="status"
              >
                {reviewing
                  ? mode === "restore"
                    ? "Uploading, decrypting, and validating your recovery file. Keep this page open…"
                    : "Creating your administrator and identity keys…"
                  : "Checking your setup token…"}
              </p>
            )}
            <div className={classes("wizard-actions")}>
              {step > 0 && step < last && (
                <Button
                  type="button"
                  onPress={() => {
                    setError("");
                    setStep(step - 1);
                  }}
                  variant="secondary"
                >
                  ← Back
                </Button>
              )}
              {step === last ? (
                <Button type="button" onPress={onComplete} variant="accent">
                  Continue to sign in →
                </Button>
              ) : (
                <Button type="submit" variant="accent">
                  {busy
                    ? "Please wait…"
                    : reviewing
                      ? mode === "create"
                        ? "Create companion"
                        : "Restore companion"
                      : "Continue →"}
                </Button>
              )}
            </div>
          </fieldset>
        </Form>
      </main>
    </div>
  );
}
