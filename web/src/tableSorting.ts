import type { SortDescriptor } from "@react-spectrum/s2";

type SortValue = string | number | null | undefined;
const collator = new Intl.Collator("en-US", {
  numeric: true,
  sensitivity: "base",
});

export function sortTableRows<Item>(
  items: readonly Item[],
  descriptor: SortDescriptor,
  columns: Record<string, (item: Item) => SortValue>,
): Item[] {
  const valueFor = columns[String(descriptor.column)];
  if (!valueFor) return [...items];
  return [...items].sort((first, second) => {
    const firstValue = valueFor(first);
    const secondValue = valueFor(second);
    const firstMissing =
      firstValue == null ||
      (typeof firstValue === "number" && !Number.isFinite(firstValue));
    const secondMissing =
      secondValue == null ||
      (typeof secondValue === "number" && !Number.isFinite(secondValue));
    if (firstMissing) return secondMissing ? 0 : 1;
    if (secondMissing) return -1;
    const difference =
      typeof firstValue === "number" && typeof secondValue === "number"
        ? firstValue - secondValue
        : collator.compare(String(firstValue), String(secondValue));
    return descriptor.direction === "descending" ? -difference : difference;
  });
}
