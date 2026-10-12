const TOKEN_KEY = "ledgerly.access_token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.assign("/login");
  }
  if (!res.ok) throw new Error(`api ${path}: ${res.status}`);
  return (await res.json()) as T;
}
