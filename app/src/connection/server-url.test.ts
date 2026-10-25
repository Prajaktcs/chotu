import { normalizeServerUrl } from "./server-url";

describe("normalizeServerUrl", () => {
  it.each([
    ["https://mini.ts.net:8787", "https://mini.ts.net:8787"],
    ["  https://mini.ts.net:8787/  ", "https://mini.ts.net:8787"],
    ["https://mini.ts.net:8787///", "https://mini.ts.net:8787"],
    ["HTTPS://Mini.Tailnet.TS.net:8787", "https://mini.tailnet.ts.net:8787"],
    ["mini.ts.net:8787", "https://mini.ts.net:8787"],
    ["https://mini.ts.net/chotu/", "https://mini.ts.net/chotu"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
    ["http://[::1]:8787", "http://[::1]:8787"],
  ])("%j becomes %j", (input, expected) => {
    expect(normalizeServerUrl(input)).toEqual({ ok: true, url: expected });
  });

  it.each([
    ["", "Enter the server address."],
    ["   ", "Enter the server address."],
    ["http://mini.ts.net:8787", "Use an https:// address."],
    ["http://192.168.1.4:8787", "Use an https:// address."],
    ["https://mini.ts.net:99999", "The port must be 1-65535."],
  ])("rejects %j", (input, error) => {
    expect(normalizeServerUrl(input)).toEqual({ ok: false, error });
  });

  it.each([
    "ftp://mini.ts.net",
    "https://user:pass@mini.ts.net",
    "https://mini.ts.net?x=1",
    "https://mini.ts.net#top",
    "https://mini ts.net",
    "https://",
    "https://mini.ts.net:port",
  ])("rejects malformed %j", (input) => {
    expect(normalizeServerUrl(input).ok).toBe(false);
  });
});
