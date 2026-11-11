import { AlertDialog, DialogTrigger } from "@react-spectrum/s2/AlertDialog";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import { Tooltip, TooltipTrigger } from "@react-spectrum/s2/Tooltip";
import { Focusable } from "react-aria-components";
import Delete from "@react-spectrum/s2/icons/Delete";
import { Button } from "@react-spectrum/s2/Button";

export default function RemoveAction({
  title,
  children,
  onRemove,
  isDisabled,
  actionLabel = "Remove",
  ariaLabel,
  isActionButton = false,
  disabledReason,
}: {
  title: string;
  children: string;
  onRemove: () => void;
  isDisabled: boolean;
  actionLabel?: string;
  ariaLabel?: string;
  isActionButton?: boolean;
  disabledReason?: string | undefined;
}) {
  const TriggerButton = isActionButton ? ActionButton : Button;
  const trigger = (
    <TriggerButton
      type="button"
      {...(!isActionButton ? { variant: "negative" as const } : {})}
      isDisabled={isDisabled}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    >
      {isActionButton ? <Delete /> : actionLabel}
    </TriggerButton>
  );
  if (isDisabled && disabledReason) {
    return (
      <TooltipTrigger delay={0}>
        <Focusable>
          <span
            role="button"
            aria-disabled="true"
            tabIndex={0}
            aria-label={(ariaLabel ?? actionLabel) + " unavailable"}
          >
            {trigger}
          </span>
        </Focusable>
        <Tooltip>{disabledReason}</Tooltip>
      </TooltipTrigger>
    );
  }
  return (
    <DialogTrigger>
      {isActionButton ? (
        <TooltipTrigger>
          {trigger}
          <Tooltip>Delete account</Tooltip>
        </TooltipTrigger>
      ) : (
        trigger
      )}
      <AlertDialog
        title={title}
        variant="destructive"
        primaryActionLabel={actionLabel}
        cancelLabel="Cancel"
        autoFocusButton="cancel"
        onPrimaryAction={onRemove}
      >
        {children}
      </AlertDialog>
    </DialogTrigger>
  );
}
