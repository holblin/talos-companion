import {
  TableView,
  TableHeader,
  Column,
  TableBody,
  Row,
  Cell,
  type SortDescriptor,
} from "@react-spectrum/s2/TableView";
import { useState } from "react";
import { Link } from "@react-spectrum/s2/Link";
import { Tooltip, TooltipTrigger } from "@react-spectrum/s2/Tooltip";
import Download from "@react-spectrum/s2/icons/Download";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { classes, documentClass } from "./layout";
import { backupDate, backupTime, type Backup } from "./backupPresentation";
import { sortTableRows } from "./tableSorting";

export default function BackupTable({ backups }: { backups: Backup[] }) {
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: "name",
    direction: "descending",
  });
  const sortedBackups = sortTableRows(backups, sortDescriptor, {
    name: (backup) => backupTime(backup.name)?.getTime(),
    size: (backup) => backup.bytes,
  });
  return (
    <div className={style({ minWidth: 0 })}>
      <TableView
        aria-label="Encrypted recovery files"
        overflowMode="wrap"
        sortDescriptor={sortDescriptor}
        onSortChange={setSortDescriptor}
        styles={style({ width: "full", height: "auto" })}
      >
        <TableHeader>
          <Column
            id="name"
            defaultWidth="2fr"
            minWidth={180}
            isRowHeader
            allowsSorting
            allowsResizing
          >
            Created
          </Column>
          <Column
            id="download"
            defaultWidth={110}
            minWidth={110}
            allowsResizing
          >
            Download
          </Column>
          <Column id="size" minWidth={90} allowsSorting allowsResizing>
            Size
          </Column>
        </TableHeader>
        <TableBody
          items={sortedBackups}
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
                <div
                  className={style({
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                  })}
                >
                  <div>{backupDate(backup.name)}</div>
                  <TooltipTrigger>
                    <Link
                      href={`/api/backups/${encodeURIComponent(backup.name)}`}
                      download
                      styles={style({ minWidth: 0, width: "full" })}
                    >
                      <code
                        className={documentClass(
                          "code",
                          style({
                            display: "block",
                            minWidth: 0,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                          }),
                        )}
                      >
                        {backup.name}
                      </code>
                    </Link>
                    <Tooltip>{backup.name}</Tooltip>
                  </TooltipTrigger>
                </div>
              </Cell>
              <Cell>
                <Link
                  href={`/api/backups/${encodeURIComponent(backup.name)}`}
                  download
                >
                  Download
                </Link>
              </Cell>
              <Cell>{(backup.bytes / 1024 / 1024).toFixed(2)} MB</Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
    </div>
  );
}
