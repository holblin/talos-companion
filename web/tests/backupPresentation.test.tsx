import { expect, it } from "vitest";
import {
  backupTime,
  backupDate,
  scheduleFrequency,
} from "../src/backupPresentation";

it("reads the timestamp only from recognized server archive names", () => {
  expect(backupTime("companion-1794078000-abc123ef.tcb")?.toISOString()).toBe(
    "2026-11-07T19:00:00.000Z",
  );
  expect(backupTime("imported-recovery.tcb")).toBeNull();
  expect(backupDate("imported-recovery.tcb")).toBe("Creation date unavailable");
  expect(scheduleFrequency(86400)).toBe("Every day");
  expect(scheduleFrequency(5400)).toBe("Every 90 minutes");
});
