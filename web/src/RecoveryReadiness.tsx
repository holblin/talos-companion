import { Button, StatusLight, Link } from "@react-spectrum/s2";
import {
  backupDate,
  backupTime,
  destinationName,
  scheduleFrequency,
  type Backup,
} from "./backupPresentation";
import { documentClass, layout } from "./layout";

type RecoverySettings = {
  settings: {
    schedule: {
      enabled: boolean;
      interval_seconds: number;
      destination: string;
    };
  };
  drive: { connected: boolean };
  mounted: string | null;
};

export default function RecoveryReadiness({
  overview,
  backups,
  onManage,
  onSettings,
}: {
  overview: RecoverySettings | null;
  backups: Backup[] | undefined;
  onManage: () => void;
  onSettings: () => void;
}) {
  const newest = backups?.reduce<Backup | undefined>((latest, item) => {
    if (!latest) return item;
    return (backupTime(item.name)?.getTime() ?? 0) >
      (backupTime(latest.name)?.getTime() ?? 0)
      ? item
      : latest;
  }, undefined);
  const schedule = overview?.settings.schedule;
  return (
    <>
      <dl className={layout.readiness}>
        <div>
          <dt className={documentClass("dt", layout.summaryLabel)}>
            Latest local recovery file
          </dt>
          <dd className={documentClass("dd")}>
            {backups === undefined
              ? "Unavailable until recovery files load"
              : newest
                ? backupDate(newest.name)
                : "No recovery file yet"}
          </dd>
          {newest && (
            <Link
              href={`/api/backups/${encodeURIComponent(newest.name)}`}
              download
            >
              Download latest recovery file
            </Link>
          )}
        </div>
        <div>
          <dt className={documentClass("dt", layout.summaryLabel)}>
            Automatic backups
          </dt>
          <dd className={documentClass("dd")}>
            {schedule
              ? schedule.enabled
                ? `${scheduleFrequency(schedule.interval_seconds)} · ${destinationName(schedule.destination)}`
                : "Disabled — create backups manually"
              : "Schedule unavailable"}
          </dd>
          <Button variant="secondary" onPress={onSettings}>
            Edit backup schedule
          </Button>
        </div>
      </dl>
      <StatusLight variant="neutral">
        {overview
          ? overview.drive.connected || overview.mounted
            ? "External destination configured; confirm your copy is current"
            : "Only local storage configured — add an external copy"
          : "External destination status unavailable"}
      </StatusLight>
      <p className={documentClass("p", layout.helpText)}>
        A listed archive is not a verified restore. Keep its passphrase
        separately and test restoration on a fresh instance. Include Omni’s
        database and encryption keys separately.
      </p>
      <div className={layout.inlineActions}>
        <Button variant="secondary" onPress={onManage}>
          Manage your backups ↗
        </Button>
        <Link
          href="https://github.com/holblin/talos-companion/blob/main/docs/omni.md#a-complete-disaster-recovery-plan"
          target="_blank"
          rel="noreferrer"
        >
          Recovery guide
        </Link>
      </div>
    </>
  );
}
