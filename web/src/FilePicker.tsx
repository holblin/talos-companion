import { Button } from "@react-spectrum/s2/Button";
import { FileTrigger } from "@react-spectrum/s2/FileTrigger";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

export default function FilePicker({
  label,
  file,
  onChange,
  acceptedFileTypes,
  isDisabled = false,
}: {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
  acceptedFileTypes?: string[];
  isDisabled?: boolean;
}) {
  return (
    <div
      className={style({
        display: "flex",
        flexDirection: "column",
        alignItems: "start",
        gap: 8,
        marginY: 16,
      })}
    >
      <FileTrigger
        {...(acceptedFileTypes === undefined ? {} : { acceptedFileTypes })}
        onSelect={(files) => {
          onChange(files?.[0] ?? null);
        }}
      >
        <Button type="button" variant="secondary" isDisabled={isDisabled}>
          {label}
        </Button>
      </FileTrigger>
      <span
        role="status"
        className={style({
          font: "body-sm",
          color: "neutral-subdued",
          overflowWrap: "anywhere",
        })}
      >
        {file?.name ?? "No file selected"}
      </span>
    </div>
  );
}
