import type { WeightUnit } from "@/api";

// New servers return member-unit weights; pounds remain for v1 compatibility.

export const LB_PER_KG = 2.20462262185;

/** The server's limit (health-coach MAX_WEIGHT_LB), in each unit. */
const MAX_WEIGHT: Readonly<Record<WeightUnit, number>> = { lb: 1500, kg: 680 };

export const MIN_REPS = 1;
export const MAX_REPS = 100;

/** Pounds in `unit`, unrounded. */
export function fromPounds(weightLb: number, unit: WeightUnit): number {
  return unit === "lb" ? weightLb : weightLb / LB_PER_KG;
}

/** A weight in `unit`, in pounds. */
export function toPounds(weight: number, unit: WeightUnit): number {
  return unit === "lb" ? weight : weight * LB_PER_KG;
}

/** The weight stepper's increment: 5 lb or 2.5 kg. */
export function weightStep(unit: WeightUnit): number {
  return unit === "lb" ? 5 : 2.5;
}

/**
 * A stepper's starting weight from a target in pounds, to the nearest 0.5 in
 * either unit: 135 lb stays 135, 132.28 lb is 132.5, 135 lb is 61 kg.
 * Null (bodyweight) stays null.
 */
export function prefillWeight(weightLb: number | null, unit: WeightUnit): number | null {
  if (weightLb === null) return null;
  return roundTo(fromPounds(weightLb, unit), 0.5);
}

/**
 * One step up: to the next multiple of the step (61 kg goes to 62.5), from
 * bodyweight to one step, never past the server's limit.
 */
export function stepWeightUp(weight: number | null, unit: WeightUnit): number {
  const step = weightStep(unit);
  if (weight === null) return step;
  const next = (Math.floor(weight / step + EPSILON) + 1) * step;
  return Math.min(roundTo(next, 0.5), MAX_WEIGHT[unit]);
}

/** One step down: to the previous multiple of the step; below one step is bodyweight. */
export function stepWeightDown(weight: number | null, unit: WeightUnit): number | null {
  if (weight === null) return null;
  const step = weightStep(unit);
  const next = (Math.ceil(weight / step - EPSILON) - 1) * step;
  return next < step - EPSILON ? null : roundTo(next, 0.5);
}

export function clampReps(reps: number): number {
  return Math.min(MAX_REPS, Math.max(MIN_REPS, Math.round(reps)));
}

/** `135 lb`, `61.5 kg` or `Bodyweight`. Shown to one decimal at most. */
export function formatWeight(weight: number | null, unit: WeightUnit): string {
  if (weight === null) return "Bodyweight";
  return `${trimNumber(roundTo(weight, 0.1))} ${unit}`;
}

/** A logged weight in pounds, in `unit`: 132.277 lb shows as 60 kg or 132.3 lb. */
export function formatPounds(weightLb: number | null, unit: WeightUnit): string {
  return formatWeight(weightLb === null ? null : fromPounds(weightLb, unit), unit);
}

type ServerWeight = { weight_lb: number | null; weight?: number | null; unit?: WeightUnit };

/** Prefer the server's member-unit digits; only old responses need conversion. */
export function serverWeight(value: ServerWeight, fallbackUnit: WeightUnit): number | null {
  if (value.weight !== undefined && value.unit) {
    if (value.weight === null || value.unit === fallbackUnit) return value.weight;
    return fromPounds(toPounds(value.weight, value.unit), fallbackUnit);
  }
  return value.weight_lb === null ? null : fromPounds(value.weight_lb, fallbackUnit);
}

export function formatServerWeight(value: ServerWeight, fallbackUnit: WeightUnit): string {
  return formatWeight(
    value.weight !== undefined && value.unit ? value.weight : serverWeight(value, fallbackUnit),
    value.unit ?? fallbackUnit,
  );
}

/** `135 lb × 8`. */
export function formatSet(weight: string, reps: number): string {
  return `${weight} × ${reps}`;
}

const EPSILON = 1e-9;

function roundTo(value: number, increment: number): number {
  return Number((Math.round(value / increment) * increment).toFixed(3));
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}
