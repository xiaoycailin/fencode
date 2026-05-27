type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: HeadersInit;
};

export function fcodeServerEnabled() {
  return process.env.FCODE_BACKEND === "server" && Boolean(fcodeServerBaseUrl());
}

export function fcodeServerBaseUrl() {
  return process.env.FCODE_SERVER_BASE_URL || process.env.NEXT_PUBLIC_FCODE_SERVER_BASE_URL || "";
}

export function fcodeServerUrl(path: string) {
  const baseUrl = fcodeServerBaseUrl().replace(/\/+$/, "");
  const nextPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${nextPath}`;
}

export async function fcodeServerJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(fcodeServerUrl(path), {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `fcode-server request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

