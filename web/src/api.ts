export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  extra: Record<string, string> = {},
): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "x-requested-with": "talos-companion",
      ...(!form && body ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
        ? value.error
        : `Request failed (${String(response.status)})`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}
