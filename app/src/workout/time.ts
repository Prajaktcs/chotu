import type { PlanDay } from "@/api";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * RFC 3339 in the phone's local offset at that moment, to the second:
 * `2026-10-24T18:05:00-04:00`. The server requires the offset.
 */
export function toLocalRfc3339(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  );
}

/** Whether a timestamp (ms) falls on the same local calendar day as `now`. */
export function isSameLocalDay(timestamp: number, now: Date = new Date()): boolean {
  const then = new Date(timestamp);
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  );
}

/** `9:32`, in the phone's local time. */
export function formatClock(rfc3339: string): string {
  const date = new Date(rfc3339);
  if (Number.isNaN(date.getTime())) return "";
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${pad(date.getMinutes())}`;
}

/** The plan day's name: its notes (`Upper body`), else its kind (`Strength`). */
export function planDayName(day: PlanDay | null): string | null {
  if (!day) return null;
  const notes = day.notes.trim();
  if (notes) return notes;
  return day.kind.charAt(0).toUpperCase() + day.kind.slice(1);
}

/** `SAT, OCT 24 · UPPER BODY` (the screen uppercases it). */
export function workoutOverline(today: Date, day: PlanDay | null): string {
  const date = `${WEEKDAYS[today.getDay()]}, ${MONTHS[today.getMonth()]} ${today.getDate()}`;
  const name = planDayName(day);
  return name ? `${date} · ${name}` : date;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
