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
  const input = useRef<HTMLInputElement>(null);
  const [recipients, setRecipients] = useState("");
  const [githubUser, setGithubUser] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
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
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not encrypt the recovery note",
      );
    } finally {
      setBusy(false);
    }
  }
  async function importGithub() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import public keys");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="wizard-note recovery-passphrase"
      aria-labelledby="recovery-title"
    >
      <h2 id="recovery-title">Save your backup passphrase</h2>
      <p>
        This unlocks your encrypted recovery backups. Store it in a password
        manager or another safe place <strong>outside this server</strong>.
        Losing the server and this passphrase means losing access to those
        backups.
      </p>
      <p className="hint">
        This is separate from your account password and setup token. On a
        replacement server, it protects future backups; older files still need
        their original passphrase.
      </p>
      {!saved && (
        <>
          <label className="field">
            <span>Backup passphrase — save this exact value</span>
            <input
              ref={input}
              type="text"
              readOnly
              value={passphrase}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
          </label>
          <div className="wizard-actions">
            <button
              type="button"
              onClick={() => {
                void copy();
              }}
            >
              Copy passphrase
            </button>
            <button
              type="button"
              onClick={() => {
                saveFile(
                  "talos-companion-recovery.txt",
                  `Talos Companion recovery note\nServer: ${issuer}\nBackup passphrase: ${passphrase}\n\nKeep this note outside the server. Use the passphrase with .tcb recovery files created here.\n`,
                );
                setNotice(
                  "Recovery note downloaded as plain text. Store it securely outside this server.",
                );
              }}
            >
              Download recovery note
            </button>
          </div>
          <details>
            <summary>
              Optional: protect a recovery copy with an age / SSH public key
            </summary>
            <p>
              Download an age-encrypted note containing this passphrase. Anyone
              with one matching private key can recover the note locally. You
              can paste native age keys or import supported public SSH keys from
              GitHub.
            </p>
            <fieldset disabled={busy}>
              <label className="field">
                <span>GitHub username (optional)</span>
                <input
                  value={githubUser}
                  onChange={(e) => {
                    setGithubUser(e.target.value);
                  }}
                  autoComplete="off"
                  maxLength={39}
                />
              </label>
              <button
                type="button"
                disabled={!githubUser.trim()}
                onClick={() => {
                  void importGithub();
                }}
              >
                Load GitHub public keys
              </button>
              <label className="field">
                <span>
                  Public keys — one age1, ssh-ed25519, or ssh-rsa key per line
                </span>
                <textarea
                  rows={5}
                  maxLength={32768}
                  value={recipients}
                  onChange={(e) => {
                    setRecipients(e.target.value);
                  }}
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                disabled={!recipients.trim()}
                onClick={() => {
                  void protect();
                }}
              >
                {busy ? "Working…" : "Download encrypted recovery note (.age)"}
              </button>
            </fieldset>
            <p className="hint">
              Private keys stay on your computer. Hardware-backed SSH keys are
              not supported. Keep the matching private key long-term, even if
              you remove its public key from GitHub.
            </p>
            <code className="block">
              age -d -i /path/to/private-key talos-companion-recovery.txt.age
            </code>
            <p className="hint">
              This recovers the passphrase note; use that passphrase to restore
              the .tcb backup. The encrypted note is an extra recovery copy, not
              a replacement for the backup itself.
            </p>
          </details>
        </>
      )}
      <div aria-live="polite">
        {notice && <p className="hint">{notice}</p>}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
      </div>
      <label className="check">
        <input
          type="checkbox"
          required
          checked={saved}
          onChange={(e) => {
            onSaved(e.target.checked);
            onConfirmation("");
            setNotice("");
            setError("");
          }}
        />
        I have saved this backup passphrase outside this server.
      </label>
      {saved && (
        <>
          <label className="field">
            <span>Re-enter the saved backup passphrase</span>
            <input
              type="password"
              required
              value={confirmation}
              onChange={(e) => {
                onConfirmation(e.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
            />
          </label>
          <p className="hint">
            Paste it from the place where you saved it. To see the original
            again, uncheck the box above.
          </p>
          {confirmation && (
            <p role="status">
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
