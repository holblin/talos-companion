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
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as T;
}
