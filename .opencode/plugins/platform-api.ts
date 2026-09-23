export type QueryValue = string | number | boolean | undefined | Array<string>;

export function envValue(name: string) {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name];
}

export function requiredToken(name: string) {
  const value = envValue(name)?.trim();
  if (!value) {
    throw new Error(`${name} is not configured on the OpenCode server.`);
  }
  return value;
}

export function queryUrl(
  base: string,
  params: Record<string, QueryValue>,
) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function boundedLimit(value: number | undefined, fallback = 20, max = 100) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

export async function jsonContent<T>(value: T | Promise<T>) {
  return { content: JSON.stringify(await value, null, 2) };
}

export async function getJson<T>(
  provider: string,
  url: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(`${provider} rejected its configured API token (401).`);
    }
    if (response.status === 403) {
      throw new Error(`${provider} denied this request (403); check token permissions.`);
    }
    throw new Error(`${provider} API request failed (${response.status} ${response.statusText}).`);
  }

  return (await response.json()) as T;
}

export function pathSegment(value: string) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error("An ID or path segment is required.");
  }
  return encodeURIComponent(normalized);
}
