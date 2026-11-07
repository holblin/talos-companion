export const destinations = {
  Overview: "/",
  Backups: "/backups",
  Identity: "/identity",
  Accounts: "/accounts",
  Settings: "/settings",
} as const;

export type View = keyof typeof destinations;
