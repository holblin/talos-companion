import { expect, it } from "vitest";
import { sortTableRows } from "../src/tableSorting";

const records = [
  { id: "older", name: "user10", date: 20, bytes: 100 },
  { id: "newer", name: "User2", date: 100, bytes: 9 },
  { id: "unknown", name: "alpha", date: null, bytes: 20 },
];
const columns = {
  name: (record: (typeof records)[number]) => record.name,
  date: (record: (typeof records)[number]) => record.date,
  bytes: (record: (typeof records)[number]) => record.bytes,
};

it("sorts dates and sizes numerically without mutating the input", () => {
  expect(
    sortTableRows(
      records,
      { column: "bytes", direction: "ascending" },
      columns,
    ).map((record) => record.id),
  ).toEqual(["newer", "unknown", "older"]);
  expect(
    sortTableRows(
      records,
      { column: "date", direction: "descending" },
      columns,
    ).map((record) => record.id),
  ).toEqual(["newer", "older", "unknown"]);
  expect(records.map((record) => record.id)).toEqual([
    "older",
    "newer",
    "unknown",
  ]);
});

it("uses natural case-insensitive text ordering", () => {
  expect(
    sortTableRows(
      records,
      { column: "name", direction: "ascending" },
      columns,
    ).map((record) => record.id),
  ).toEqual(["unknown", "newer", "older"]);
});

it.each(["ascending", "descending"] as const)(
  "keeps missing and nonfinite values last when %s",
  (direction) => {
    const values = [
      null,
      100,
      undefined,
      Number.NaN,
      20,
      Number.POSITIVE_INFINITY,
    ];
    const sorted = sortTableRows(
      values.map((value) => ({ value })),
      { column: "value", direction },
      { value: (record) => record.value },
    ).map((record) => record.value);
    expect(sorted.slice(0, 2)).toEqual(
      direction === "ascending" ? [20, 100] : [100, 20],
    );
    expect(sorted.slice(2)).toEqual([
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]);
  },
);

it("preserves tie order and ignores non-data columns", () => {
  const equal = [
    { id: "first", name: "A" },
    { id: "second", name: "a" },
  ];
  expect(
    sortTableRows(
      equal,
      { column: "name", direction: "descending" },
      { name: (record) => record.name },
    ),
  ).toEqual(equal);
  expect(
    sortTableRows(
      records,
      { column: "actions", direction: "ascending" },
      columns,
    ),
  ).toEqual(records);
});
