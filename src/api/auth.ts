type Headers = Record<string, string | string[] | undefined>;

function bearer(headers: Headers): string | null {
  const h = headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v?.startsWith('Bearer ')) return null;
  return v.slice('Bearer '.length);
}

export function checkAdmin(adminKey: string, headers: Headers): boolean {
  return bearer(headers) === adminKey;
}

export function checkRequestAuth(authKey: string | undefined, headers: Headers): boolean {
  if (!authKey) return true;       // open when unset
  return bearer(headers) === authKey;
}
