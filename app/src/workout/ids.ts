import { randomUUID } from "expo-crypto";

/** A fresh UUIDv4 for `Idempotency-Key`. Generated once per write and kept for its retries. */
export function newRequestId(): string {
  return randomUUID();
}
