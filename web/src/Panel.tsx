import type { ReactNode } from "react";
import { Card, Content } from "@react-spectrum/s2/Card";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { documentClass } from "./layout";

// Preserve document landmarks and heading levels while S2 owns the card surface.
export default function Panel({
  title,
  label = title,
  children,
  id,
}: {
  title?: string;
  label?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      aria-label={label}
      id={id}
      tabIndex={id ? -1 : undefined}
      className={style({ minWidth: 0, marginBottom: { default: 16, md: 24 } })}
    >
      <Card styles={style({ width: "full", minWidth: 0 })}>
        <Content>
          <div className={style({ gridColumn: "1 / -1", minWidth: 0 })}>
            {title && <h2 className={documentClass("h2")}>{title}</h2>}
            {children}
          </div>
        </Content>
      </Card>
    </section>
  );
}
