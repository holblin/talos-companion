export const destinations = {
  Overview: "/",
  Backups: "/backups",
  "Companion access": "/access",
  "Omni configuration": "/omni-configuration",
  Accounts: "/accounts",
  Settings: "/settings",
  "Change password": "/change-password",
} as const;

export type View = keyof typeof destinations;
