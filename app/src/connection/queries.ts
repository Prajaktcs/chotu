/** The TanStack Query key for `/v1/me` without a member (the profile list). */
export function meQueryKey(serverUrl: string | null): readonly ["me", string | null] {
  return ["me", serverUrl];
}
