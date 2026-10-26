/**
 * React keys for a list of labels that may repeat: the label, then `#2`,
 * `#3` for later repeats, so each row keeps its key when others change.
 */
export function uniqueKeys(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label}#${count}`;
  });
}
