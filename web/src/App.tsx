import { documentClass } from "./layout";
import RemoveAction from "./RemoveAction";
import FilePicker from "./FilePicker";
import BackupDestinations, {
  BackupFrequency,
  GoogleDriveSetup,
} from "./BackupSetup";
import { classes, layout } from "./layout";
import Input from "./Field";
import Cloud from "@react-spectrum/s2/icons/Cloud";
import People from "@react-spectrum/s2/icons/People";
import {
  SideNav,
  SideNavItem,
  SideNavItemContent,
  SideNavItemLink,
  Text,
  Form,
  ProgressCircle,
  StatusLight,
  Button,
  Checkbox,
  Picker,
  PickerItem,
  ToastQueue,
  ActionMenu,
  MenuItem,
  Disclosure,
  DisclosureTitle,
  DisclosurePanel,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { SubmitEvent, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { destinations, type View } from "./navigation";
import { queryClient } from "./query";
import { useTask } from "./useTask";
import { api, ApiError } from "./api";
import QueryNotice from "./QueryNotice";
import RecoveryReadiness from "./RecoveryReadiness";
import { type Backup } from "./backupPresentation";
const SetupWizard = lazy(() => import("./SetupWizard"));
const OmniSetup = lazy(() =>
  import("./AccessPages").then((module) => ({
    default: module.OmniConfiguration,
  })),
);
const CompanionAccess = lazy(() =>
  import("./AccessPages").then((module) => ({
    default: module.CompanionAccess,
  })),
);

type User = { id: string; email: string; name: string; admin: boolean };
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
  s3_endpoint: string;
  s3_access_key: string;
  s3_secret_key: string;
  bucket: string;
  mounted: string | null;
  drive: { client_id: string; folder_id: string; connected: boolean };
  streaming_backups: boolean;
  retention: { recovery_keep_last: number; snapshot_keep_last: number };
};
const views: View[] = [
  "Overview",
  "Backups",
  "Companion access",
  "Omni configuration",
  "Accounts",
  "Settings",
];

function fields(
  e: Pick<SubmitEvent<HTMLFormElement>, "preventDefault" | "currentTarget">,
) {
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
    <span className={classes("logo")} aria-hidden="true">
      T<span>+</span>
    </span>
  );
}
function Card({
  title,
  children,
  className = "",
  id,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      className={classes(`card ${className}`)}
      aria-label={title}
      id={id}
      tabIndex={id ? -1 : undefined}
    >
      {title && <h2 className={documentClass("h2")}>{title}</h2>}
      {children}
    </section>
  );
}
function Secret({ label, value }: { label: string; value: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className={classes("secret")}>
      <span>{label}</span>
      <div className={layout.secretValue}>
        <code className={documentClass("code")}>
          {show ? value : "••••••••••••••••••••••••"}
        </code>
        <Button
          onPress={() => {
            setShow(!show);
          }}
          type="button"
          variant="secondary"
        >
          {show ? "Hide" : "Reveal"}
        </Button>
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

export default function App() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const hash = useRouterState({ select: (state) => state.location.hash });
  const view: View =
    (pathname === "/identity"
      ? "Omni configuration"
      : (Object.entries(destinations).find(
          ([, path]) => path === pathname,
        )?.[0] as View | undefined)) ?? "Overview";
  function setView(next: View) {
    void navigate({ to: destinations[next] });
  }
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => api<{ initialized: boolean }>("/api/status"),
  });
  const initialized = status.data?.initialized ?? null;
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        return await api<User>("/api/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    enabled: initialized === true,
  });
  const user = session.data ?? null;
  function setUser(next: User | null) {
    setCredentialFile(null);
    setRecoveryExpires(null);
    queryClient.removeQueries({ queryKey: ["admin"] });
    queryClient.removeQueries({ queryKey: ["omni"] });
    queryClient.setQueryData(["session"], next);
  }
  function setInitialized(value: boolean) {
    queryClient.setQueryData(["status"], { initialized: value });
  }
  const overviewQuery = useQuery({
    queryKey: ["admin", user?.id, "overview"],
    enabled: user?.admin === true,
    queryFn: () => api<Overview>("/api/overview"),
  });
  const backupsQuery = useQuery({
    queryKey: ["admin", user?.id, "backups"],
    enabled: user?.admin === true,
    queryFn: () => api<Backup[]>("/api/backups"),
  });
  const usersQuery = useQuery({
    queryKey: ["admin", user?.id, "users"],
    enabled: user?.admin === true,
    queryFn: () => api<User[]>("/api/users"),
  });
  const vaultQuery = useQuery({
    queryKey: ["admin", user?.id, "vault"],
    enabled: user?.admin === true,
    queryFn: () => api<string[]>("/api/vault"),
  });
  const overview = overviewQuery.data ?? null;
  const backups = backupsQuery.data ?? [];
  const users = usersQuery.data ?? [];
  const vault = vaultQuery.data ?? [];
  const { busy, notice, setNotice, work } = useTask({ toastErrors: true });
  const loadError = status.error ?? session.error;
  const adminError =
    overviewQuery.error ??
    backupsQuery.error ??
    usersQuery.error ??
    vaultQuery.error;
  const adminLoading =
    overviewQuery.isPending ||
    backupsQuery.isPending ||
    usersQuery.isPending ||
    vaultQuery.isPending;
  const [credentialFile, setCredentialFile] = useState<File | null>(null);
  const [recoveryExpires, setRecoveryExpires] = useState<number | null>(null);
  const [recovering, setRecovering] = useState(false);
  const signInHeading = useRef<HTMLHeadingElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    signInHeading.current?.focus();
  }, [recovering]);
  useEffect(() => {
    if (!user) return;
    const target = hash ? document.getElementById(hash) : null;
    (target ?? pageHeading.current)?.focus();
    document.title = `${view} · Talos Companion`;
  }, [view, user, hash]);
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin"] });
  }
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
      {loadError && (
        <div className={classes("message error")} role="alert">
          {loadError.message}
        </div>
      )}
      {notice && <div className={classes("message")}>{notice}</div>}
    </div>
  );
  if (initialized === null || (initialized && session.isPending))
    return (
      <main className={classes("loading")}>
        <Logo />
        {!loadError && (
          <ProgressCircle
            aria-label="Connecting to your companion"
            isIndeterminate
          />
        )}
        <p className={documentClass("p")}>
          {loadError?.message || "Connecting to your companion…"}
        </p>
        {loadError && (
          <Button
            variant="secondary"
            onPress={() => {
              void status.refetch();
            }}
          >
            Try again
          </Button>
        )}
      </main>
    );

  if (!initialized)
    return (
      <Suspense
        fallback={
          <main className={classes("loading")}>
            <ProgressCircle aria-label="Loading setup" isIndeterminate />
          </main>
        }
      >
        <SetupWizard
          onComplete={() => {
            setInitialized(true);
            setNotice("Setup complete. Sign in to continue.");
          }}
        />
      </Suspense>
    );

  if (!user)
    return (
      <div className={classes("welcome")}>
        <div className={classes("welcome-story")}>
          <div className={classes("brand")}>
            <Logo /> talos companion
          </div>
          <div className={classes("story-detail")}>
            <h1 className={documentClass("h1")}>
              Your infrastructure.
              <br />
              <em>Your identity.</em>
              <br />
              Your peace of mind.
            </h1>
            <p className={documentClass("p")}>
              Accounts and recovery for Talos Omni.
              <br />
              Simple to run. Ready when you need it.
            </p>
          </div>
          <footer className={classes("footnote desktop-only")}>
            Self-hosted by you
          </footer>
        </div>
        <main className={classes("welcome-form")}>
          <div className={classes("onboarding")}>
            <h2
              className={documentClass("h2")}
              ref={signInHeading}
              tabIndex={-1}
            >
              {recovering
                ? "Recover administrator access"
                : "Sign in to your companion"}
            </h2>
            <p className={documentClass("p", layout.subtitle)}>
              {recovering
                ? "Reset your administrator password using a recovery code."
                : "Use your companion account to continue."}
            </p>
            {messages}
            {!recovering ? (
              <>
                <fieldset className={documentClass("fieldset")} disabled={busy}>
                  <Form
                    isDisabled={busy}
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
                    <Button type="submit" variant="accent">
                      {busy ? "Signing in…" : "Sign in →"}
                    </Button>
                  </Form>
                </fieldset>
                <Button
                  type="button"
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    setRecovering(true);
                  }}
                >
                  Forgot the administrator password?
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    setRecovering(false);
                  }}
                >
                  Back to sign in
                </Button>
                <p className={documentClass("p", classes("hint"))}>
                  The server owner can recover access without losing accounts,
                  identity or backups. Request a code here, then read it in
                  Companion’s server logs. No command or restart is needed.
                </p>
                <Button
                  isDisabled={busy}
                  onPress={() => {
                    void work(async () => {
                      const result = await api<{ expires_at: number }>(
                        "/api/password/recovery-code",
                        {},
                      );
                      setRecoveryExpires(result.expires_at);
                    });
                  }}
                  type="button"
                  variant="accent"
                >
                  Print recovery code to server logs
                </Button>
                {recoveryExpires !== null && (
                  <div className={classes("message")} role="status">
                    Look for “Password recovery code:” in Companion’s server
                    logs. This code expires at{" "}
                    {new Date(recoveryExpires * 1000).toLocaleString()}.
                    Repeated requests keep the same active code; it is printed
                    only once.
                  </div>
                )}
                <p className={documentClass("p", classes("hint"))}>
                  On Unraid, open Docker → talos-companion → Logs. For other
                  installations, use the service’s logs or terminal output. Find
                  the latest “Password recovery code:” entry. It is valid for 15
                  minutes and one successful reset, with at most five failed
                  verification attempts. Repeated requests do not replace an
                  active log code or extend its expiry, even after a restart.
                </p>
                <p className={documentClass("p", classes("hint"))}>
                  Your current password keeps working until you finish below.
                  The code cannot sign in to Companion or Omni. Anyone who can
                  read these logs can recover the administrator account. Keep
                  logs private and exclude recovery entries from shared log
                  exports.
                </p>
                <fieldset className={documentClass("fieldset")} disabled={busy}>
                  <Form
                    isDisabled={busy}
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
                        setRecoveryExpires(null);
                        setRecovering(false);
                        ToastQueue.positive(
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
                    <Button type="submit" variant="accent">
                      Reset password using recovery code
                    </Button>
                  </Form>
                </fieldset>
                <a
                  className={documentClass("a")}
                  href="https://github.com/holblin/talos-companion/blob/main/docs/home-setup.md#recover-a-forgotten-administrator-password"
                  target="_blank"
                  rel="noreferrer"
                >
                  Recovery instructions ↗
                </a>
              </>
            )}
          </div>
        </main>
      </div>
    );

  const titles: Record<View, string> = {
    Overview: "Everything in its place.",
    Backups: "A way back, always.",
    "Companion access": "Your companion. Within reach.",
    "Omni configuration": "One identity. Your Omni.",
    Accounts: "The people you trust.",
    Settings: "Make yourself at home.",
  };
  function signOut() {
    void work(async () => {
      await api("/api/logout", {});
      setUser(null);
    });
  }
  const backupSettings = user.admin && overview && (
    <Card title="Backup settings">
      <Form
        isDisabled={busy}
        key={JSON.stringify(overview.settings)}
        onSubmit={(e) => {
          const data = fields(e);
          void work(async () => {
            await api("/api/settings", {
              retention: {
                recovery_keep_last: Number(data["recovery_keep_last"]),
                snapshot_keep_last: Number(data["snapshot_keep_last"]),
              },
              schedule: {
                enabled: data["enabled"] === "on",
                interval_seconds: Number(data["interval_seconds"]),
                destination: data["destination"],
              },
            });
            await refresh();
            setNotice("Backup settings saved and applied.");
          });
        }}
      >
        <Checkbox
          name="enabled"
          defaultSelected={overview.settings.schedule.enabled}
          styles={style({ width: "full", marginY: 12 })}
        >
          Enable scheduled backups
        </Checkbox>
        <BackupFrequency
          seconds={overview.settings.schedule.interval_seconds}
        />
        <Picker
          label={<>Scheduled destination</>}
          name="destination"
          defaultValue={overview.settings.schedule.destination}
          styles={style({ width: "full", marginY: 12 })}
        >
          <PickerItem id="local">Local storage</PickerItem>
          <PickerItem id="mounted" isDisabled={!overview.mounted}>
            Mounted NFS / SMB
          </PickerItem>
          <PickerItem id="drive" isDisabled={!overview.drive.connected}>
            Google Drive
          </PickerItem>
        </Picker>
        <details className={documentClass("details")}>
          <summary className={documentClass("summary")}>
            Retention settings
          </summary>
          <Input
            label="Recovery files to keep per destination"
            name="recovery_keep_last"
            type="number"
            min={0}
            max={1000000}
            step={1}
            defaultValue={overview.settings.retention.recovery_keep_last}
          />
          <Input
            label="Omni snapshots to keep per cluster"
            name="snapshot_keep_last"
            type="number"
            min={0}
            max={1000000}
            step={1}
            defaultValue={overview.settings.retention.snapshot_keep_last}
          />
          <p className={documentClass("p", classes("hint"))}>
            Use 0 to keep everything. Retention applies after the next
            successful backup.
          </p>
        </details>
        <Button type="submit" variant="accent">
          Save backup settings
        </Button>
      </Form>
      <p className={documentClass("p", classes("hint"))}>
        Saved in /data/config.json and included in recovery backups. Changes
        apply immediately. An active backup finishes with its original settings.
      </p>
    </Card>
  );
  return (
    <div className={classes("shell")}>
      <a
        className={layout.skipLink}
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          pageHeading.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <aside className={classes("sidebar")}>
        <div className={classes("brand-row")}>
          <div className={classes("brand")}>
            <Logo />
            <div>
              talos<span className={layout.brandDetail}>companion</span>
            </div>
          </div>
          <div className={classes("mobile-only")}>
            <ActionMenu aria-label="Account menu" size="L">
              <MenuItem id="sign-out" onAction={signOut}>
                <Text>{user.name} · Sign out</Text>
              </MenuItem>
            </ActionMenu>
          </div>
        </div>
        <div className={classes("workspace")}>
          <span className={classes("dot")} />
          <div>
            My infrastructure
            <small className={documentClass("small", layout.brandDetail)}>
              Self-hosted workspace
            </small>
          </div>
        </div>
        <div className={classes("desktop-only")}>
          <SideNav
            aria-label="Workspace"
            selectedRoute={destinations[view]}
            styles={style({ flexGrow: 0 })}
          >
            {views
              .filter((v) => user.admin || v === "Settings")
              .map((v) => (
                <SideNavItem
                  key={v}
                  id={v}
                  textValue={v}
                  href={destinations[v]}
                >
                  <SideNavItemContent>
                    <SideNavItemLink>
                      <Text>{v}</Text>
                    </SideNavItemLink>
                  </SideNavItemContent>
                </SideNavItem>
              ))}
          </SideNav>
        </div>
        <div
          className={style({
            display: { default: "none", lg: "flex" },
            flexGrow: 1,
          })}
        >
          <div className={classes("sidebar-bottom")}>
            <div className={classes("status")}>
              <span className={classes("dot")} /> All yours. All local.
            </div>
            <Button onPress={signOut} type="button" variant="secondary">
              <Text>{user.name} · Sign out</Text>
            </Button>
          </div>
        </div>
      </aside>
      <main className={classes("main")} id="main-content">
        <header className={classes("topbar")}>
          <span className={classes("desktop-only")}>
            Workspace <b>/</b> {view}
          </span>
          <div className={classes("mobile-only")}>
            <Picker
              aria-label="Workspace page"
              value={view}
              onChange={(value) => {
                if (views.includes(value as View)) setView(value as View);
              }}
              styles={style({ width: 160 })}
            >
              {views
                .filter((v) => user.admin || v === "Settings")
                .map((v) => (
                  <PickerItem key={v} id={v}>
                    {v}
                  </PickerItem>
                ))}
            </Picker>
          </div>
          <StatusLight
            variant={user.admin && adminError ? "notice" : "neutral"}
          >
            {user.admin
              ? adminError
                ? "Some data unavailable"
                : adminLoading
                  ? "Loading workspace"
                  : "Workspace data loaded"
              : "Signed in"}
          </StatusLight>
        </header>
        <div className={classes("content")}>
          <div className={classes("page-title")}>
            <div>
              <h1
                className={documentClass("h1")}
                ref={pageHeading}
                tabIndex={-1}
              >
                {user.admin ? titles[view] : "Your account."}
              </h1>
              <p className={documentClass("p", layout.subtitle)}>
                {view === "Overview"
                  ? "Check your recovery files, backup routine, and connections."
                  : "Identity and recovery, under your control."}
              </p>
            </div>
            {user.admin && (
              <Button
                isDisabled={busy}
                onPress={() => void createBackup("local")}
                type="button"
                variant="accent"
              >
                {busy ? "Working…" : "Create local backup"}
              </Button>
            )}
          </div>
          {messages}
          {user.admin && (
            <>
              <QueryNotice
                label="Infrastructure and settings"
                query={overviewQuery}
              />
              <QueryNotice label="Recovery files" query={backupsQuery} />
              {view === "Accounts" || view === "Overview" ? (
                <QueryNotice label="Accounts" query={usersQuery} />
              ) : null}
              {view === "Backups" ? (
                <QueryNotice label="Recovery material" query={vaultQuery} />
              ) : null}
            </>
          )}
          <fieldset className={documentClass("fieldset")} disabled={busy}>
            {user.admin && view === "Overview" && (
              <>
                <dl className={layout.summary} aria-label="Workspace summary">
                  <div className={layout.summaryItem}>
                    <dt className={documentClass("dt", layout.summaryLabel)}>
                      Identity provider
                    </dt>
                    <dd className={documentClass("dd", layout.summaryValue)}>
                      {overviewQuery.data === undefined
                        ? overviewQuery.isPending
                          ? "Loading…"
                          : "Unavailable"
                        : overview?.redirect_uri
                          ? "Configured"
                          : "Needs setup"}
                    </dd>
                  </div>
                  <div className={layout.summaryItem}>
                    <dt className={documentClass("dt", layout.summaryLabel)}>
                      Recovery files
                    </dt>
                    <dd className={documentClass("dd", layout.summaryValue)}>
                      {backupsQuery.data === undefined
                        ? backupsQuery.isPending
                          ? "Loading…"
                          : "Unavailable"
                        : `${String(backups.length)} encrypted`}
                    </dd>
                  </div>
                  <div className={layout.summaryItem}>
                    <dt className={documentClass("dt", layout.summaryLabel)}>
                      Your people
                    </dt>
                    <dd className={documentClass("dd", layout.summaryValue)}>
                      {usersQuery.data === undefined
                        ? usersQuery.isPending
                          ? "Loading…"
                          : "Unavailable"
                        : `${String(users.length)} ${users.length === 1 ? "account" : "accounts"}`}
                    </dd>
                  </div>
                </dl>
                <div className={classes("overview-grid")}>
                  <Card
                    className={classes("recovery-card")}
                    title="Recovery readiness"
                  >
                    <RecoveryReadiness
                      overview={overview}
                      backups={backupsQuery.data}
                      onManage={() => {
                        setView("Backups");
                      }}
                      onSettings={() => {
                        setView("Settings");
                      }}
                    />
                  </Card>
                  <Card title="Your infrastructure">
                    <div className={classes("service")}>
                      <span
                        className={classes("service-logo")}
                        aria-hidden="true"
                      >
                        <People />
                      </span>
                      <div className={layout.serviceContent}>
                        <b>Talos Omni</b>
                        <small
                          className={documentClass(
                            "small",
                            layout.serviceDetail,
                          )}
                        >
                          OIDC identity + S3 backup receiver
                        </small>
                      </div>
                      <StatusLight
                        variant={
                          overview?.redirect_uri ? "positive" : "neutral"
                        }
                      >
                        {overview
                          ? overview.redirect_uri
                            ? "Configured"
                            : "Not configured"
                          : overviewQuery.isPending
                            ? "Loading…"
                            : "Unavailable"}
                      </StatusLight>
                      <Button
                        variant="secondary"
                        onPress={() => {
                          setView("Omni configuration");
                        }}
                      >
                        Configure Omni
                      </Button>
                    </div>
                    <div className={classes("service")}>
                      <span
                        className={classes("service-logo")}
                        aria-hidden="true"
                      >
                        <Cloud />
                      </span>
                      <div className={layout.serviceContent}>
                        <b>Google Drive</b>
                        <small
                          className={documentClass(
                            "small",
                            layout.serviceDetail,
                          )}
                        >
                          Off-site encrypted recovery files
                        </small>
                      </div>
                      <StatusLight
                        variant={
                          overview?.drive.connected ? "positive" : "neutral"
                        }
                      >
                        {overview === null
                          ? overviewQuery.isPending
                            ? "Loading…"
                            : "Unavailable"
                          : overview.drive.connected
                            ? "Connected"
                            : "Not connected"}
                      </StatusLight>
                      <Button
                        variant="secondary"
                        onPress={() => {
                          void navigate({
                            to: "/settings",
                            hash: "google-drive",
                          });
                        }}
                      >
                        Connect Google Drive
                      </Button>
                    </div>
                  </Card>
                </div>
                <Card title="Recent recovery files">
                  {backupsQuery.data !== undefined && (
                    <RecoveryFiles backups={backups.slice(0, 3)} />
                  )}
                </Card>
                <div className={classes("footnote")}>
                  Small footprint. Important job.{" "}
                  <span>Built for your homelab.</span>
                </div>
              </>
            )}
            {user.admin && view === "Backups" && (
              <>
                <Card title="Your recovery files">
                  {backupsQuery.data !== undefined && (
                    <RecoveryFiles backups={backups} />
                  )}
                  {overview && (
                    <p className={documentClass("p", classes("hint"))}>
                      Recovery files contain password hashes and identity keys.
                      Encryption uses your BACKUP_PASSPHRASE. Recovery files
                      stream without a fixed size cap. Retention:{" "}
                      {overview.retention.recovery_keep_last
                        ? `newest ${String(overview.retention.recovery_keep_last)} recovery files per destination`
                        : "all recovery files"}
                      {"; "}
                      {overview.retention.snapshot_keep_last
                        ? `newest ${String(overview.retention.snapshot_keep_last)} Omni snapshots per cluster`
                        : "all received Omni snapshots"}
                      .
                    </p>
                  )}
                </Card>
                <Disclosure>
                  <DisclosureTitle>
                    Backup destinations and schedule
                  </DisclosureTitle>
                  <DisclosurePanel>
                    {overview && (
                      <BackupDestinations
                        overview={overview}
                        createBackup={createBackup}
                        refresh={refresh}
                      />
                    )}
                    {backupSettings}
                  </DisclosurePanel>
                </Disclosure>
                <Disclosure>
                  <DisclosureTitle>
                    Omni credentials and recovery material
                  </DisclosureTitle>
                  <DisclosurePanel>
                    <div className={layout.disclosureContent}>
                      <p className={documentClass("p")}>
                        Add your Omni configuration, encryption keys, or other
                        recovery files here. These files stay private to
                        administrators and are included in encrypted recovery
                        backups.
                      </p>
                      <Form
                        isDisabled={busy}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = e.currentTarget;
                          const data = new FormData(form);
                          void work(async () => {
                            if (!credentialFile)
                              throw new Error(
                                "Choose a credential file to upload.",
                              );
                            if (credentialFile.size > 16 * 1024 * 1024)
                              throw new Error(
                                "Credential file exceeds 16 MiB.",
                              );
                            data.set("file", credentialFile);
                            await api("/api/vault", data);
                            setCredentialFile(null);
                            form.reset();
                            await refresh();
                            setNotice(
                              "Credential file saved. Create a backup to include it in a recovery file.",
                            );
                          });
                        }}
                      >
                        <FilePicker
                          label="Choose credential file (up to 16 MiB)"
                          file={credentialFile}
                          onChange={setCredentialFile}
                          isDisabled={busy}
                        />
                        <Button type="submit" variant="secondary">
                          Save credential file →
                        </Button>
                      </Form>
                      {vault.map((name) => (
                        <div className={classes("account")} key={name}>
                          <code className={documentClass("code")}>{name}</code>
                          <a
                            className={documentClass("a", classes("download"))}
                            href={`/api/vault/${encodeURIComponent(name)}`}
                          >
                            Download ↓
                          </a>
                          <RemoveAction
                            title="Remove credential file?"
                            isDisabled={busy}
                            onRemove={() => {
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
                            {`Remove ${name} from live storage? Existing recovery files will retain it.`}
                          </RemoveAction>
                        </div>
                      ))}
                      <p className={documentClass("p", classes("hint"))}>
                        Uploading a file with the same name replaces the
                        previous version. Companion does not automatically
                        collect Omni’s own database or encryption material.
                      </p>
                    </div>
                  </DisclosurePanel>
                </Disclosure>
                <Disclosure>
                  <DisclosureTitle>Restore on a fresh instance</DisclosureTitle>
                  <DisclosurePanel>
                    <div className={layout.disclosureContent}>
                      <p className={documentClass("p")}>
                        Start a new container with an empty data directory.
                        Choose “Restore an existing companion” on the
                        first-launch screen. Supply your original passphrase,
                        and optionally replace the first administrator’s
                        credentials.
                      </p>
                      <p className={documentClass("p", classes("hint"))}>
                        Cluster backups received over S3 are separate from
                        Omni’s own database and encryption-key backups. Include
                        those separately using the documented recovery
                        procedure.
                      </p>
                    </div>
                  </DisclosurePanel>
                </Disclosure>
              </>
            )}
            {user.admin && view === "Companion access" && (
              <Suspense
                fallback={
                  <ProgressCircle
                    aria-label="Loading Companion access"
                    isIndeterminate
                  />
                }
              >
                <CompanionAccess />
              </Suspense>
            )}
            {user.admin && view === "Omni configuration" && overview && (
              <>
                <Suspense
                  fallback={
                    <ProgressCircle
                      aria-label="Loading Omni settings"
                      isIndeterminate
                    />
                  }
                >
                  <OmniSetup>
                    <details
                      className={documentClass("details", classes("card"))}
                    >
                      <summary className={documentClass("summary")}>
                        Advanced settings: identity and backup credentials
                      </summary>
                      <div className={classes("two-cols")}>
                        <Card title="Give Omni a familiar face">
                          <p className={documentClass("p")}>
                            Your companion is a dedicated identity provider for
                            one Omni instance. Add Omni’s exact callback URL,
                            then configure Omni with these values.
                          </p>
                          <dl>
                            <dt className={documentClass("dt")}>Issuer URL</dt>
                            <dd className={documentClass("dd")}>
                              <code className={documentClass("code")}>
                                {overview.issuer}
                              </code>
                            </dd>
                            <dt className={documentClass("dt")}>Client ID</dt>
                            <dd className={documentClass("dd")}>
                              <code className={documentClass("code")}>
                                {overview.client_id}
                              </code>
                            </dd>
                          </dl>
                          <Secret
                            label="Client secret"
                            value={overview.client_secret}
                          />
                          <Form
                            isDisabled={busy}
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
                            <Button type="submit" variant="accent">
                              Save callback URL
                            </Button>
                          </Form>
                        </Card>
                        <Card title="A home for Omni backups">
                          <p className={documentClass("p")}>
                            Use the verified backup endpoint from the guided
                            setup. The bucket is created automatically after
                            account setup.
                          </p>
                          <dl>
                            <dt className={documentClass("dt")}>Bucket</dt>
                            <dd className={documentClass("dd")}>
                              <code className={documentClass("code")}>
                                omni
                              </code>
                            </dd>
                            <dt className={documentClass("dt")}>Region</dt>
                            <dd className={documentClass("dd")}>
                              <code className={documentClass("code")}>
                                us-east-1
                              </code>
                            </dd>
                            <dt className={documentClass("dt")}>Endpoint</dt>
                            <dd className={documentClass("dd")}>
                              <code className={documentClass("code")}>
                                {overview.s3_endpoint ||
                                  "Complete the guided connection setup above."}
                              </code>
                            </dd>
                          </dl>
                          <Secret
                            label="Access key"
                            value={overview.s3_access_key}
                          />
                          <Secret
                            label="Secret key"
                            value={overview.s3_secret_key}
                          />
                          <p className={documentClass("p", classes("hint"))}>
                            Configure Omni with S3 backups enabled. See
                            docs/omni.md for the resource template and full
                            setup instructions. Omni access roles are managed in
                            Omni.
                          </p>
                        </Card>
                      </div>
                    </details>
                  </OmniSetup>
                </Suspense>
              </>
            )}
            {user.admin && view === "Accounts" && (
              <div className={classes("two-cols")}>
                <Card title="Workspace accounts">
                  <div className={classes("account-list")}>
                    {users.map((u) => (
                      <div className={classes("account")} key={u.id}>
                        <span className={classes("avatar")}>
                          {u.name.slice(0, 1)}
                        </span>
                        <div>
                          <b>{u.name}</b>
                          <small
                            className={documentClass(
                              "small",
                              layout.brandDetail,
                            )}
                          >
                            {u.email} · {u.admin ? "Administrator" : "Member"}
                          </small>
                        </div>
                        {u.id !== user.id && (
                          <RemoveAction
                            title="Remove account?"
                            isDisabled={busy}
                            onRemove={() => {
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
                            {`Remove ${u.email}? This revokes their companion sessions and future Omni sign-ins.`}
                          </RemoveAction>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className={documentClass("p", classes("hint"))}>
                    Administrators can manage identity settings, people, and
                    backups. Members can sign in to Omni and change their own
                    password. Adding an email here is an administrator’s
                    assertion that it belongs to that person.
                  </p>
                </Card>
                <Card title="Invite someone in">
                  <Form
                    isDisabled={busy}
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
                    <Checkbox
                      name="admin"
                      styles={style({ width: "full", marginY: 12 })}
                    >
                      Administrator access
                    </Checkbox>
                    <Button type="submit" variant="accent">
                      Create account
                    </Button>
                  </Form>
                </Card>
              </div>
            )}
            {(view === "Settings" || !user.admin) && (
              <div className={classes("two-cols")}>
                {backupSettings}
                <Card title="Change your password">
                  <Form
                    isDisabled={busy}
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
                    <Button type="submit" variant="accent">
                      Update password
                    </Button>
                  </Form>
                  <p className={documentClass("p", classes("hint"))}>
                    Changing your password signs you out of all companion
                    sessions.
                  </p>
                </Card>
                {user.admin && (
                  <Card title="Connect Google Drive" id="google-drive">
                    {overview && (
                      <GoogleDriveSetup
                        issuer={overview.issuer}
                        drive={overview.drive}
                      />
                    )}
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

const BackupTable = lazy(() => import("./BackupTable"));
function RecoveryFiles({ backups }: { backups: Backup[] }) {
  return (
    <Suspense
      fallback={
        <ProgressCircle aria-label="Loading recovery files" isIndeterminate />
      }
    >
      <BackupTable backups={backups} />
    </Suspense>
  );
}
