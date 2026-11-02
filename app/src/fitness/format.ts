import type { HistorySet, TrendPoint, WorkoutTrendsResponse } from "@/api";
import { shortDate } from "@/plan/format";
import { formatWeight } from "@/workout/units";

export const HISTORY_PAGE_DAYS = 10;
export const TREND_RANGES = [7, 28, 90] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

export function historyQueryKey(scope: string): readonly ["workout-history", string] {
  return ["workout-history", scope];
}

export function trendsQueryKey(
  scope: string,
  days: TrendRange,
): readonly ["workout-trends", string, TrendRange] {
  return ["workout-trends", scope, days];
}

/** `135 lb × 8` or `Bodyweight × 12`, in the unit the server sent. */
export function setText(set: HistorySet): string {
  return `${formatWeight(set.weight, set.unit)} × ${set.reps}`;
}

/** The time a set was done, on this phone's clock: `9:05 AM`. */
export function setTime(set: HistorySet): string {
  const at = new Date(set.performed_at);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A day's working sets: `135 lb × 8/7` or `Bodyweight × 12`. */
export function pointText(point: TrendPoint): string {
  return `${formatWeight(point.top_weight, point.unit)} × ${point.reps.join("/")}`;
}

/**
 * First-to-latest change in top load, from recorded sessions only. Null with
 * fewer than two sessions, or when either end was bodyweight.
 */
export function loadChange(points: readonly TrendPoint[]): string | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first.top_weight === null || last.top_weight === null) return null;
  const delta = Math.round((last.top_weight - first.top_weight) * 10) / 10;
  if (delta === 0) return `Same top load (${formatWeight(last.top_weight, last.unit)})`;
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatWeight(Math.abs(delta), last.unit)} top load`;
}

/** `Oct 5` for a `YYYY-MM-DD` day. */
function monthDay(day: string): string {
  return shortDate(day).replace(/^\w+, /, "");
}

/** `Oct 5 – Nov 1` (a range of household days). */
export function rangeText(trends: Pick<WorkoutTrendsResponse, "from" | "to">): string {
  return `${monthDay(trends.from)} – ${monthDay(trends.to)}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
