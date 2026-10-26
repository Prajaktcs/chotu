export type ServerUrlResult = { ok: true; url: string } | { ok: false; error: string };

// scheme://host[:port][/path], no user info, query or fragment.
const URL_PATTERN = /^(https?):\/\/([^/?#@\s]+)(\/[^?#\s]*)?$/i;
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalises a typed server address: trims it, adds `https://` when no scheme
 * is given, lowercases the scheme and host, and strips trailing slashes.
 * Only `https://` is accepted, except plain `http://` to this machine
 * (localhost, 127.0.0.1, [::1]) for development.
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "Enter the server address." };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const match = URL_PATTERN.exec(withScheme);
  if (!match) {
    return { ok: false, error: "Enter an address like https://mini.ts.net:8787." };
  }
  const scheme = (match[1] ?? "").toLowerCase();
  const host = (match[2] ?? "").toLowerCase();
  const path = (match[3] ?? "").replace(/\/+$/, "");

  const hostMatch = HOST_PATTERN.exec(host);
  if (!hostMatch) {
    return { ok: false, error: "Enter an address like https://mini.ts.net:8787." };
  }
  const hostname = hostMatch[1] ?? "";
  const port = hostMatch[2];
  if (port !== undefined) {
    const number = Number(port);
    if (number < 1 || number > 65535) return { ok: false, error: "The port must be 1-65535." };
  }
  if (scheme === "http" && !LOOPBACK_HOSTS.has(hostname)) {
    return { ok: false, error: "Use an https:// address." };
  }
  return { ok: true, url: `${scheme}://${host}${path}` };
}
