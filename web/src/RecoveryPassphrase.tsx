import { documentClass } from "./layout";
import { useTask } from "./useTask";
import { classes } from "./layout";
import type { TextFieldRef } from "@react-spectrum/s2";
import { TextArea } from "@react-spectrum/s2/TextArea";
import { TextField } from "@react-spectrum/s2/TextField";
import { Button } from "@react-spectrum/s2/Button";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useRef, useState } from "react";
import { api } from "./api";

function saveFile(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
export default function RecoveryPassphrase({
  passphrase,
  issuer,
  setupToken,
  saved,
  confirmation,
  onSaved,
  onConfirmation,
}: {
  passphrase: string;
  issuer: string;
  setupToken: string;
  saved: boolean;
  confirmation: string;
  onSaved: (saved: boolean) => void;
  onConfirmation: (value: string) => void;
}) {
  const input = useRef<TextFieldRef>(null);
  const [recipients, setRecipients] = useState("");
  const [githubUser, setGithubUser] = useState("");
  const { busy, error, notice, setError, setNotice, work } = useTask();
  async function copy() {
    input.current?.select();
    try {
      if (!window.isSecureContext) {
        setNotice(
          "Passphrase selected. Press Ctrl+C (or Command+C) to copy it on this HTTP connection.",
        );
        return;
      }
      await navigator.clipboard.writeText(passphrase);
      setNotice(
        "Copied. Save it in your password manager or somewhere outside this server.",
      );
    } catch {
      setNotice(
        "Select the passphrase and press Ctrl+C (or Command+C) to copy it.",
      );
    }
  }
  async function protect() {
    await work(async () => {
      const result = await api<{ file_name: string; encrypted_file: string }>(
        "/api/setup/recovery-key",
        { recipients },
        "POST",
        { "x-setup-token": setupToken },
      );
      saveFile(result.file_name, result.encrypted_file);
      setNotice(
        "Encrypted recovery note downloaded. Keep it outside this server and retain the matching private key.",
      );
    });
  }
  async function importGithub() {
    await work(async () => {
      const result = await api<{ recipients: string; omitted: number }>(
        "/api/setup/github-keys",
        { username: githubUser },
        "POST",
        { "x-setup-token": setupToken },
      );
      setRecipients(result.recipients);
      setNotice(
        `GitHub public keys loaded. Review the keys below and confirm you retain a matching private key.${result.omitted ? ` ${String(result.omitted)} unsupported or excess keys omitted.` : ""}`,
      );
    });
  }
  return (
    <section
      className={classes("wizard-note recovery-passphrase")}
      aria-labelledby="recovery-title"
    >
      <h2 className={documentClass("h2")} id="recovery-title">
        Save your backup passphrase
      </h2>
      <p className={documentClass("p")}>
        This unlocks your encrypted recovery backups. Store it in a password
        manager or another safe place <strong>outside this server</strong>.
        Losing the server and this passphrase means losing access to those
        backups.
      </p>
      <p className={documentClass("p", classes("hint"))}>
        This is separate from your account password and setup token. On a
        replacement server, it protects future backups; older files still need
        their original passphrase.
      </p>
      {!saved && (
        <>
          <TextField
            label={<>Backup passphrase — save this exact value</>}
            ref={input}
            isReadOnly
            value={passphrase}
            autoComplete="off"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
            styles={style({ width: "full", marginY: 12 })}
          ></TextField>
          <div className={classes("wizard-actions")}>
            <Button
              type="button"
              onPress={() => {
                void copy();
              }}
              variant="secondary"
            >
              Copy passphrase
            </Button>
            <Button
              type="button"
              onPress={() => {
                saveFile(
                  "talos-companion-recovery.txt",
                  `Talos Companion recovery note\nServer: ${issuer}\nBackup passphrase: ${passphrase}\n\nKeep this note outside the server. Use the passphrase with .tcb recovery files created here.\n`,
                );
                setNotice(
                  "Recovery note downloaded as plain text. Store it securely outside this server.",
                );
              }}
              variant="secondary"
            >
              Download recovery note
            </Button>
          </div>
          <details className={documentClass("details")}>
            <summary className={documentClass("summary")}>
              Optional: protect a recovery copy with an age / SSH public key
            </summary>
            <p className={documentClass("p")}>
              Download an age-encrypted note containing this passphrase. Anyone
              with one matching private key can recover the note locally. You
              can paste native age keys or import supported public SSH keys from
              GitHub.
            </p>
            <fieldset className={documentClass("fieldset")} disabled={busy}>
              <TextField
                label={<>GitHub username (optional)</>}
                value={githubUser}
                onChange={(value) => {
                  setGithubUser(value);
                }}
                autoComplete="off"
                maxLength={39}
                styles={style({ width: "full", marginY: 12 })}
              ></TextField>
              <Button
                type="button"
                isDisabled={!githubUser.trim()}
                onPress={() => {
                  void importGithub();
                }}
                variant="secondary"
              >
                Load GitHub public keys
              </Button>
              <TextArea
                label="Public keys — one age1, ssh-ed25519, or ssh-rsa key per line"
                maxLength={32768}
                value={recipients}
                onChange={setRecipients}
                styles={style({ width: "full", marginY: 16 })}
              />
              <Button
                type="button"
                isDisabled={!recipients.trim()}
                onPress={() => {
                  void protect();
                }}
                variant="secondary"
              >
                {busy ? "Working…" : "Download encrypted recovery note (.age)"}
              </Button>
            </fieldset>
            <p className={documentClass("p", classes("hint"))}>
              Private keys stay on your computer. Hardware-backed SSH keys are
              not supported. Keep the matching private key long-term, even if
              you remove its public key from GitHub.
            </p>
            <code className={documentClass("code", classes("block"))}>
              age -d -i /path/to/private-key talos-companion-recovery.txt.age
            </code>
            <p className={documentClass("p", classes("hint"))}>
              This recovers the passphrase note; use that passphrase to restore
              the .tcb backup. The encrypted note is an extra recovery copy, not
              a replacement for the backup itself.
            </p>
          </details>
        </>
      )}
      <div aria-live="polite">
        {notice && (
          <p className={documentClass("p", classes("hint"))}>{notice}</p>
        )}
        {error && (
          <p
            className={documentClass("p", classes("message error"))}
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
      <Checkbox
        isRequired
        isSelected={saved}
        onChange={(value) => {
          onSaved(value);
          onConfirmation("");
          setNotice("");
          setError("");
        }}
        styles={style({ width: "full", marginY: 12 })}
      >
        I have saved this backup passphrase outside this server.
      </Checkbox>
      {saved && (
        <>
          <TextField
            type="password"
            label={<>Re-enter the saved backup passphrase</>}
            isRequired
            value={confirmation}
            onChange={(value) => {
              onConfirmation(value);
            }}
            autoComplete="off"
            maxLength={4096}
            styles={style({ width: "full", marginY: 12 })}
          ></TextField>
          <p className={documentClass("p", classes("hint"))}>
            Paste it from the place where you saved it. To see the original
            again, uncheck the box above.
          </p>
          {confirmation && (
            <p className={documentClass("p")} role="status">
              {confirmation === passphrase
                ? "Passphrase matches. Your recovery details are ready."
                : "The passphrase does not match yet."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
