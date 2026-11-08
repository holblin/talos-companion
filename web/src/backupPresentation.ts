export type Backup = { name: string; bytes: number };

// Companion archives encode their creation time in their server-generated name.
// Unknown/imported names remain unknown rather than receiving an invented date.
export function backupTime(name: string): Date | null {
  const match = /^companion-(\d{10})-[a-zA-Z0-9]+\.tcb$/.exec(name);
  if (!match?.[1]) return null;
  const date = new Date(Number(match[1]) * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function backupDate(name: string) {
  return (
    backupTime(name)?.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }) ?? "Creation date unavailable"
  );
}

export function scheduleFrequency(seconds: number) {
  if (seconds === 3600) return "Every hour";
  if (seconds === 86400) return "Every day";
  if (seconds === 604800) return "Every week";
  if (seconds % 3600 === 0) return `Every ${String(seconds / 3600)} hours`;
  if (seconds % 60 === 0) return `Every ${String(seconds / 60)} minutes`;
  return `Every ${String(seconds)} seconds`;
}

export function destinationName(destination: string) {
  return destination === "drive"
    ? "Google Drive"
    : destination === "network"
      ? "NFS / SMB"
      : "Local storage";
}
