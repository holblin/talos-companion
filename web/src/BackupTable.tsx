import {
  TableView,
  TableHeader,
  Column,
  TableBody,
  Row,
  Cell,
} from "@react-spectrum/s2/TableView";
import { Link } from "@react-spectrum/s2/Link";
import Download from "@react-spectrum/s2/icons/Download";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { classes, documentClass } from "./layout";
import { backupDate, type Backup } from "./backupPresentation";

export default function BackupTable({ backups }: { backups: Backup[] }) {
  return (
    <div className={style({ minWidth: 0 })}>
      <TableView
        aria-label="Encrypted recovery files"
        overflowMode="wrap"
        styles={style({ width: "full", height: "auto" })}
      >
        <TableHeader>
          <Column id="name" width="2fr" minWidth={180} isRowHeader>
            Recovery file
          </Column>
          <Column id="size" minWidth={90}>
            Size
          </Column>
          <Column id="download" minWidth={110}>
            Download
          </Column>
        </TableHeader>
        <TableBody
          items={backups}
          renderEmptyState={() => (
            <div className={classes("empty")}>
              <Download styles={style({ marginBottom: 16 })} />
              <h3 className={documentClass("h3")}>
                Your first backup starts here.
              </h3>
              <p className={documentClass("p")}>
                Create a recovery file to keep your accounts and infrastructure
                safe.
              </p>
            </div>
          )}
        >
          {(backup) => (
            <Row id={backup.name} textValue={backup.name}>
              <Cell>
                <div>{backupDate(backup.name)}</div>
                <code className={documentClass("code")}>{backup.name}</code>
              </Cell>
              <Cell>{(backup.bytes / 1024 / 1024).toFixed(2)} MB</Cell>
              <Cell>
                <Link
                  href={`/api/backups/${encodeURIComponent(backup.name)}`}
                  download
                >
                  Download
                </Link>
              </Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
    </div>
  );
}
