import { AlertDialog, DialogTrigger } from "@react-spectrum/s2/AlertDialog";
import { Button } from "@react-spectrum/s2/Button";

export default function RemoveAction({
  title,
  children,
  onRemove,
  isDisabled,
}: {
  title: string;
  children: string;
  onRemove: () => void;
  isDisabled: boolean;
}) {
  return (
    <DialogTrigger>
      <Button type="button" variant="negative" isDisabled={isDisabled}>
        Remove
      </Button>
      <AlertDialog
        title={title}
        variant="destructive"
        primaryActionLabel="Remove"
        cancelLabel="Cancel"
        autoFocusButton="cancel"
        onPrimaryAction={onRemove}
      >
        {children}
      </AlertDialog>
    </DialogTrigger>
  );
}
