import { useState } from "react";

/**
 * The latest loaded answer, kept when a later query (another range) fails
 * before it ever loads. The answer carries its own range, so it stays
 * labelled as what it is.
 */
export function useKeptData<T>(data: T | undefined): T | undefined {
  const [kept, setKept] = useState(data);
  // Adjusting state while rendering, React's pattern for state derived from props.
  if (data !== undefined && data !== kept) setKept(data);
  return data ?? kept;
}
