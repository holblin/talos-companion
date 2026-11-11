export const destinations = {
  Overview: "/",
  "Companion access": "/access",
  Backups: "/backups",
  "Omni configuration": "/omni-configuration",
  Accounts: "/accounts",
  Settings: "/settings",
  "Change password": "/change-password",
} as const;

export type View = keyof typeof destinations;
