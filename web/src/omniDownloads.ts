/** Downloads only from administrator-authorized server endpoints; never persist secrets in query caches. */
export async function downloadOmni(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      "x-requested-with": "talos-companion",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  if (!response.ok) {
    const value = (await response.json()) as { error?: string };
    throw new Error(value.error ?? "Could not download Omni configuration");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "omni.yaml";
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
