import type { Meal } from "@/api";
import { dayOverline } from "@/status/format";

export function foodQueryKey(scope: string, date: string): readonly ["food", string, string] {
  return ["food", scope, date];
}

/** The phone's calendar day as `YYYY-MM-DD`. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** `date` moved by whole calendar days. */
export function shiftDate(date: string, days: number): string {
  // Noon keeps a calendar date on the same day across DST changes.
  const day = new Date(`${date}T12:00:00`);
  day.setDate(day.getDate() + days);
  return localDate(day);
}

/** `Today`, `Yesterday`, else `MON, OCT 26`. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === shiftDate(today, -1)) return "Yesterday";
  return dayOverline(date);
}

const grams = (value: number) => `${Math.round(value)}g`;

/** `420 kcal · 25g P / 38g C / 17g F`. */
export function macroLine(
  meal: Pick<Meal, "calories" | "protein_g" | "carbs_g" | "fat_g">,
): string {
  return `${Math.round(meal.calories)} kcal · ${grams(meal.protein_g)} P / ${grams(meal.carbs_g)} C / ${grams(meal.fat_g)} F`;
}

/** The logged meals added up. */
export function dayTotals(
  meals: readonly Meal[],
): Pick<Meal, "calories" | "protein_g" | "carbs_g" | "fat_g"> {
  return meals.reduce(
    (total, meal) => ({
      calories: total.calories + meal.calories,
      protein_g: total.protein_g + meal.protein_g,
      carbs_g: total.carbs_g + meal.carbs_g,
      fat_g: total.fat_g + meal.fat_g,
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
}

/** `12:30 PM` in the phone's zone. */
export function mealTime(meal: Meal): string {
  return new Date(meal.eaten_at).toLocaleTimeString(undefined, { timeStyle: "short" });
}
