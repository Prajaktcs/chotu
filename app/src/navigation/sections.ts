import type { Href } from "expo-router";

/**
 * The app's sections and their four tabs (docs/app-parity.md, #169).
 *
 * A tab names the screen that implements it; a tab without a screen is not
 * built yet and shows as unavailable. A section with no available screen is
 * unavailable too. Later phases add a screen here instead of changing the shell.
 */

/** Every screen reachable from section navigation. */
export type ScreenId =
  | "today"
  | "workout"
  | "plan"
  | "fitness-history"
  | "fitness-trends"
  | "food"
  | "food-log"
  | "food-goals"
  | "food-trends"
  | "health"
  | "health-checkins"
  | "health-conditions"
  | "health-trends"
  | "tasks"
  | "tasks-upcoming"
  | "tasks-completed"
  | "tasks-trends";

export type SectionId =
  | "today"
  | "fitness"
  | "nutrition"
  | "health"
  | "tasks"
  | "finance"
  | "memory";

export type SectionTab = { label: string; screen?: ScreenId };

export type Section = {
  id: SectionId;
  label: string;
  /** `future` sections are roadmap concepts, listed under Coming later. */
  group: "main" | "future";
  /** Today has no tabs: it is one screen. Every other section has exactly four. */
  tabs: readonly SectionTab[];
  /** Today's own screen. */
  screen?: ScreenId;
};

export const screenHrefs: Readonly<Record<ScreenId, Href>> = {
  today: "/today",
  workout: "/workout",
  plan: "/plan",
  "fitness-history": "/fitness/history",
  "fitness-trends": "/fitness/trends",
  food: "/food",
  "food-log": "/food/log",
  "food-goals": "/food/goals",
  "food-trends": "/food/trends",
  health: "/wellbeing",
  "health-checkins": "/wellbeing/check-ins",
  "health-conditions": "/wellbeing/conditions",
  "health-trends": "/wellbeing/trends",
  tasks: "/tasks",
  "tasks-upcoming": "/tasks/upcoming",
  "tasks-completed": "/tasks/completed",
  "tasks-trends": "/tasks/trends",
};

export const sections: readonly Section[] = [
  { id: "today", label: "Today", group: "main", tabs: [], screen: "today" },
  {
    id: "fitness",
    label: "Fitness",
    group: "main",
    tabs: [
      { label: "Workout", screen: "workout" },
      { label: "Plan", screen: "plan" },
      { label: "History", screen: "fitness-history" },
      { label: "Trends", screen: "fitness-trends" },
    ],
  },
  {
    id: "nutrition",
    label: "Nutrition",
    group: "main",
    tabs: [
      { label: "Today", screen: "food" },
      { label: "Food log", screen: "food-log" },
      { label: "Goals", screen: "food-goals" },
      { label: "Trends", screen: "food-trends" },
    ],
  },
  {
    id: "health",
    label: "Wellbeing",
    group: "main",
    tabs: [
      { label: "Overview", screen: "health" },
      { label: "Check-ins", screen: "health-checkins" },
      { label: "Conditions", screen: "health-conditions" },
      { label: "Trends", screen: "health-trends" },
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    group: "main",
    tabs: [
      { label: "Today", screen: "tasks" },
      { label: "Upcoming", screen: "tasks-upcoming" },
      { label: "Completed", screen: "tasks-completed" },
      { label: "Trends", screen: "tasks-trends" },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    group: "future",
    tabs: [
      { label: "Overview" },
      { label: "Transactions" },
      { label: "Budgets" },
      { label: "Trends" },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    group: "future",
    tabs: [
      { label: "Overview" },
      { label: "Memories" },
      { label: "Topics" },
      { label: "Activity" },
    ],
  },
];

/** The section a screen belongs to. */
export function sectionOf(screen: ScreenId): Section {
  const section = sections.find(
    (candidate) =>
      candidate.screen === screen || candidate.tabs.some((tab) => tab.screen === screen),
  );
  if (!section) throw new Error(`No section has the ${screen} screen`);
  return section;
}

// The last tab opened in each section, so returning to a section reopens it.
// In memory only: it is a convenience, not profile data.
const lastScreen = new Map<SectionId, ScreenId>();

export function rememberScreen(screen: ScreenId): void {
  lastScreen.set(sectionOf(screen).id, screen);
}

/** Where a section opens: its last opened tab, else its first available one; null if none is built. */
export function entryScreen(section: Section): ScreenId | null {
  const remembered = lastScreen.get(section.id);
  if (remembered) return remembered;
  return section.screen ?? section.tabs.find((tab) => tab.screen)?.screen ?? null;
}

/** Forgets remembered tabs (tests). */
export function resetRememberedScreens(): void {
  lastScreen.clear();
}
