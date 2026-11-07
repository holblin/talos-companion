import {
  TableView,
  TableHeader,
  Column,
  TableBody,
  Row,
  Cell,
  Link,
  Text,
} from "@react-spectrum/s2";
import Download from "@react-spectrum/s2/icons/Download";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { classes, documentClass, layout } from "./layout";
import { backupDate, type Backup } from "./backupPresentation";

export default function BackupTable({ backups }: { backups: Backup[] }) {
  return backups.length ? (
    <>
      <ul className={layout.backupList} aria-label="Recovery file downloads">
        {backups.map((backup) => (
          <li key={backup.name} className={layout.backupItem}>
            <strong>{backupDate(backup.name)}</strong>
            <Text>
              {(backup.bytes / 1024 / 1024).toFixed(2)} MB · Encrypted
            </Text>
            <details className={documentClass("details", layout.fileDetails)}>
              <summary className={documentClass("summary")}>File name</summary>
              <code className={documentClass("code")}>{backup.name}</code>
            </details>
            <Link
              href={`/api/backups/${encodeURIComponent(backup.name)}`}
              download
            >
              Download recovery file
            </Link>
          </li>
        ))}
      </ul>
      <div className={layout.backupTable}>
        <TableView
          aria-label="Encrypted recovery files"
          overflowMode="wrap"
          styles={style({ width: "full", height: "auto" })}
        >
          <TableHeader>
            <Column id="name" width="2fr" minWidth={280} isRowHeader>
              Recovery file
            </Column>
            <Column id="size" minWidth={90}>
              Size
            </Column>
            <Column id="protection" minWidth={110}>
              Protection
            </Column>
            <Column id="download" minWidth={110}>
              Download
            </Column>
          </TableHeader>
          <TableBody items={backups}>
            {(backup) => (
              <Row id={backup.name}>
                <Cell>
                  <div>{backupDate(backup.name)}</div>
                  <code className={documentClass("code")}>{backup.name}</code>
                </Cell>
                <Cell>{(backup.bytes / 1024 / 1024).toFixed(2)} MB</Cell>
                <Cell>Encrypted</Cell>
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
    </>
  ) : (
    <div className={classes("empty")}>
      <Download styles={style({ marginBottom: 16 })} />
      <h3 className={documentClass("h3")}>Your first backup starts here.</h3>
      <p className={documentClass("p")}>
        Create a recovery file to keep your accounts and infrastructure safe.
      </p>
    </div>
  );
}
