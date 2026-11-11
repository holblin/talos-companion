import type { ReactNode } from "react";
import {
  Disclosure,
  DisclosureTitle,
  DisclosurePanel,
} from "@react-spectrum/s2/Disclosure";

export default function ContextHelp({
  title,
  children,
  defaultExpanded = false,
}: {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  return (
    <Disclosure defaultExpanded={defaultExpanded}>
      <DisclosureTitle>{title}</DisclosureTitle>
      <DisclosurePanel>{children}</DisclosurePanel>
    </Disclosure>
  );
}
