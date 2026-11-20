import { useState } from "react";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import { ActionButtonGroup } from "@react-spectrum/s2/ActionButtonGroup";
import { Tooltip, TooltipTrigger } from "@react-spectrum/s2/Tooltip";
import { ToastQueue } from "@react-spectrum/s2/Toast";
import Copy from "@react-spectrum/s2/icons/Copy";
import Visibility from "@react-spectrum/s2/icons/Visibility";
import VisibilityOff from "@react-spectrum/s2/icons/VisibilityOff";
import { classes, documentClass, layout } from "./layout";

export default function Secret({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [show, setShow] = useState(false);
  const [copying, setCopying] = useState(false);

  async function copy() {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(value);
      ToastQueue.positive(`${label} copied.`);
    } catch {
      ToastQueue.negative(
        "Could not copy. Reveal and select the value instead.",
      );
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className={classes("secret")}>
      <span>{label}</span>
      <div className={layout.secretValue}>
        <code className={documentClass("code")}>
          {show ? value : "••••••••••••••••••••••••"}
        </code>
        <ActionButtonGroup aria-label={`${label} actions`}>
          <TooltipTrigger>
            <ActionButton
              aria-label={`${show ? "Hide" : "Reveal"} ${label}`}
              onPress={() => {
                setShow(!show);
              }}
            >
              {show ? <VisibilityOff /> : <Visibility />}
            </ActionButton>
            <Tooltip>{`${show ? "Hide" : "Reveal"} ${label}`}</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger>
            <ActionButton
              aria-label={`Copy ${label}`}
              isPending={copying}
              onPress={() => {
                void copy();
              }}
            >
              <Copy />
            </ActionButton>
            <Tooltip>{`Copy ${label}`}</Tooltip>
          </TooltipTrigger>
        </ActionButtonGroup>
      </div>
    </div>
  );
}
