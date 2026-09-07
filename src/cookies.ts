export function parseCookieString(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.replace(/[\r\n\t]+/g, ' ').split(';')) {
    const at = part.indexOf('=');
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (at > 0 && name && value && !/[\s={}?&]/.test(name)) cookies.set(name, value);
  }
  return cookies;
}

export function serializeCookieMap(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

// Only pass responses from the jar's own origin; never mix GitHub and AgentRouter cookies.
export function mergeSetCookies(cookies: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const attrs = new Map(attributes.map((attribute) => {
      const [key, ...rest] = attribute.trim().split('=');
      return [key.toLowerCase(), rest.join('=')] as const;
    }));
    const maxAge = attrs.get('max-age');
    const expired = maxAge !== undefined && /^-?\d+$/.test(maxAge)
      ? Number(maxAge) <= 0
      : Date.parse(attrs.get('expires') || '') <= Date.now();
    if (!value || expired) cookies.delete(name);
    else cookies.set(name, value);
  }
}

export async function captureGithubCookies(
  cookies: Map<string, string>,
  context: { cookies(url: string): Promise<{ name: string; value: string }[]> }
): Promise<void> {
  const latest = await context.cookies('https://github.com');
  cookies.clear();
  for (const { name, value } of latest) if (value) cookies.set(name, value);
}
