import { createContext, useContext } from "react";

const PendingSetCountContext = createContext<number | null>(null);

/**
 * Supplies the number of sets waiting to send. The offline queue (#128)
 * wraps the app in this; without it the count is unknown and the recovery
 * screens hide the "N sets waiting to send" card.
 */
export const PendingSetCountProvider = PendingSetCountContext.Provider;

/** Sets waiting to send, or null when no queue reports a count. */
export function usePendingSetCount(): number | null {
  return useContext(PendingSetCountContext);
}

export function pendingSetsLabel(count: number): string {
  return `${count} ${count === 1 ? "set" : "sets"} waiting to send`;
}
