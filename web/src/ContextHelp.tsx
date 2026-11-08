import type { ReactNode } from "react";
import {
  Disclosure,
  DisclosureTitle,
  DisclosurePanel,
} from "@react-spectrum/s2";

export default function ContextHelp({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Disclosure>
      <DisclosureTitle>{title}</DisclosureTitle>
      <DisclosurePanel>{children}</DisclosurePanel>
    </Disclosure>
  );
}
