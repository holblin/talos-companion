export const destinations = {
  Overview: "/",
  Backups: "/backups",
  "Companion access": "/access",
  "Omni configuration": "/omni-configuration",
  Accounts: "/accounts",
  Settings: "/settings",
} as const;

export type View = keyof typeof destinations;
