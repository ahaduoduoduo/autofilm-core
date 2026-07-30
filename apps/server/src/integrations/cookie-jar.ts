export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(cookieHeader = "") {
    this.absorbCookieHeader(cookieHeader);
  }

  absorb(headers: Headers): void {
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : splitSetCookie(headers.get("set-cookie") ?? "");
    for (const value of values) {
      const pair = value.split(";", 1)[0]?.trim();
      if (pair) this.absorbCookieHeader(pair);
    }
  }

  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private absorbCookieHeader(header: string): void {
    for (const part of header.split(";")) {
      const pair = part.trim();
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }
}

function splitSetCookie(value: string): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/);
}
