import { Button } from "@react-spectrum/s2/Button";
import { ProgressCircle } from "@react-spectrum/s2/ProgressCircle";
import { classes, documentClass, layout } from "./layout";

type QueryState = {
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
  data: unknown;
  refetch: () => Promise<unknown>;
};

export default function QueryNotice({
  label,
  query,
}: {
  label: string;
  query: QueryState;
}) {
  if (query.error)
    return (
      <div className={classes("message error")} role="alert">
        <p className={documentClass("p")}>
          {label} unavailable. {query.error.message}
          {query.data !== undefined &&
            " Previously loaded data is shown below."}
        </p>
        <Button
          variant="secondary"
          isDisabled={query.isFetching}
          onPress={() => {
            void query.refetch();
          }}
        >
          {query.isFetching
            ? `Retrying ${label.toLowerCase()}…`
            : `Retry ${label.toLowerCase()}`}
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <div className={layout.inlineStatus} role="status">
        <ProgressCircle
          size="S"
          isIndeterminate
          aria-label={`Loading ${label.toLowerCase()}`}
        />
        <span>Loading {label.toLowerCase()}…</span>
      </div>
    );
  return null;
}
