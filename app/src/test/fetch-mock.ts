/** A route table for a mocked fetch: `"GET /v1/me"` to a response factory. */
export type Routes = Record<string, (init: RequestInit) => Response>;

export type FetchCall = {
  method: string;
  path: string;
  /** The query string, e.g. `?date=2026-10-27`, or empty. */
  search: string;
  headers: Record<string, string>;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const HEALTH = { status: "ok", server_version: "0.1.0+abc", min_app_version: "0.1.0" };

/**
 * Installs a global fetch that answers from `routes` (404 otherwise) and
 * records each call. A route that throws is a network failure.
 */
export function mockFetch(routes: Routes): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = jest.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const route = routes[`${method} ${url.pathname}`];
    try {
      return Promise.resolve(route ? route(init) : new Response("", { status: 404 }));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
