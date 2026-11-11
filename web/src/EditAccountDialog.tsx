import { useId } from "react";
import { Dialog } from "@react-spectrum/s2/Dialog";
import { Heading } from "@react-spectrum/s2/Heading";
import { Content } from "@react-spectrum/s2/Content";
import { Form } from "@react-spectrum/s2/Form";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import Input from "./Field";
import { api } from "./api";
import { useTask } from "./useTask";
import { documentClass } from "./layout";

type Account = { id: string; name: string; email: string; admin: boolean };
export default function EditAccountDialog({
  account,
  lastAdmin,
  onSaved,
  onClose,
}: {
  account: Account;
  lastAdmin: boolean;
  onSaved: (account: Account) => Promise<void>;
  onClose: () => void;
}) {
  const formId = useId();
  const { busy, error, work } = useTask();
  return (
    <Dialog aria-label="Edit account">
      <Heading slot="title">Edit account</Heading>
      <Content>
        <p className={documentClass("p")}>
          Update the account's name, sign-in email, and Companion role. The
          password stays unchanged.
        </p>
        <Form
          id={formId}
          isDisabled={busy}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void work(async () => {
              const updated = await api<Account>(
                "/api/users/" + account.id,
                {
                  name: data.get("name"),
                  email: data.get("email"),
                  admin: lastAdmin || data.has("admin"),
                },
                "PUT",
              );
              await onSaved(updated);
              onClose();
            });
          }}
        >
          <Input
            compact
            label="Display name"
            name="name"
            defaultValue={account.name}
            autoComplete="name"
          />
          <Input
            compact
            label="Email address"
            name="email"
            type="email"
            defaultValue={account.email}
            autoComplete="username"
          />
          <Checkbox
            name="admin"
            defaultSelected={account.admin}
            isDisabled={lastAdmin}
          >
            Administrator access
          </Checkbox>
          <p className={documentClass("p")}>
            Administrators manage Companion accounts, access, backups,
            credentials, and settings. Members can sign in and change their own
            password. Omni permissions are managed separately.
          </p>
          {lastAdmin && (
            <p className={documentClass("p")}>
              This is the last administrator. Add another administrator before
              removing this role or deleting this account.
            </p>
          )}
          {error && (
            <p role="alert" className={documentClass("p")}>
              {error}
            </p>
          )}
        </Form>
      </Content>
      <ButtonGroup>
        <Button variant="secondary" isDisabled={busy} onPress={onClose}>
          Cancel
        </Button>
        <Button variant="accent" type="submit" form={formId} isDisabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </ButtonGroup>
    </Dialog>
  );
}
