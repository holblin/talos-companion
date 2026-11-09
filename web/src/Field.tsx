import { NumberField } from "@react-spectrum/s2/NumberField";
import { TextField } from "@react-spectrum/s2/TextField";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

type FieldProps = {
  label: string;
  name?: string;
  type?: "text" | "email" | "password" | "url" | "number";
  required?: boolean;
  placeholder?: string;
  value?: string | number;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  autoComplete?: string;
  onChange?: (value: string) => void;
};

export default function Field({
  label,
  type = "text",
  required = true,
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
  ...props
}: FieldProps) {
  const common = {
    label,
    isRequired: required,
    styles: style({ width: "full", marginY: 12 }),
    ...(props.name === undefined ? {} : { name: props.name }),
  };
  if (type === "number") {
    return (
      <NumberField
        {...common}
        {...(value === undefined ? {} : { value: Number(value) })}
        {...(defaultValue === undefined
          ? {}
          : { defaultValue: Number(defaultValue) })}
        {...(min === undefined ? {} : { minValue: min })}
        {...(max === undefined ? {} : { maxValue: max })}
        {...(step === undefined ? {} : { step })}
        {...(onChange === undefined
          ? {}
          : {
              onChange: (number: number) => {
                onChange(String(number));
              },
            })}
        isWheelDisabled
      />
    );
  }
  return (
    <TextField
      {...common}
      {...props}
      type={type}
      {...(value === undefined ? {} : { value: String(value) })}
      {...(defaultValue === undefined
        ? {}
        : { defaultValue: String(defaultValue) })}
      {...(onChange === undefined ? {} : { onChange })}
    />
  );
}
