/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Only the endpoint -> existing app type association is maintained here. There
// is no parallel schema: the real TypeScript compiler validates parsed values
// against types.ts, including literal unions, nested objects and optional keys.
const bodies = {
  health: "Health",
  me: "Me",
  "me-no-member": "Me",
  "workout-before": "WorkoutResponse",
  "workout-open": "WorkoutResponse",
  "workout-no-plan": "WorkoutResponse",
  "workout-unplanned": "WorkoutResponse",
  "set-log-request": "LogSetRequest",
  "set-log-request-bodyweight": "LogSetRequest",
  "set-log-request-kg": "LogSetRequest",
  "set-logged": "SetLoggedResponse",
  "set-deleted": "SetDeletedResponse",
  "workout-done": "WorkoutDoneResponse",
  "tasks-list": "TasksResponse",
  "task-complete": "TaskResponse",
  "task-snooze": "TaskResponse",
  "task-snooze-request": "SnoozeRequest",
  status: "StatusResponse",
  "status-empty": "StatusResponse",
  "status-fitness-nullable": "StatusResponse",
  "status-focus-cut": "StatusResponse",
  "status-focus-bulk": "StatusResponse",
  "status-focus-recomp": "StatusResponse",
  "status-focus-endurance": "StatusResponse",
  plan: "PlanResponse",
  "plan-nullable": "PlanResponse",
  "plan-no-goals": "PlanResponse",
  "plan-not-generated": "PlanResponse",
  "plan-unreadable": "PlanResponse",
  error: "ErrorBody",
  "error-coded": "ErrorBody",
  "error-426": "ErrorBody",
};

function readFixture(name) {
  return JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));
}

// Older supported servers omit additive fields. Derive those compatibility
// examples from actual Rust bodies rather than maintaining legacy DTO mirrors.
function omitFields(value, fields) {
  if (Array.isArray(value)) return value.map((item) => omitFields(item, fields));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !fields.includes(key))
        .map(([key, item]) => [key, omitFields(item, fields)]),
    );
  }
  return value;
}

function compile(samples) {
  const directory = mkdtempSync(path.join(tmpdir(), "chotu-api-fixtures-"));
  try {
    const typesPath = JSON.stringify(path.join(__dirname, "types"));
    const clientPath = JSON.stringify(path.join(__dirname, "client"));
    for (const sample of samples) {
      const fixturePath = JSON.stringify(
        path.join(__dirname, "fixtures", `${sample.fixture}.json`),
      );
      writeFileSync(
        path.join(directory, `${sample.name}.ts`),
        `import type * as API from ${typesPath};
import type { ApiClient } from ${clientPath};
type SnoozeRequest = { days: Parameters<ApiClient["snoozeTask"]>[1] };
// JSON imports widen string literal unions. Check their complete structural
// shape here, then check exact literals below (no casts to the API type).
type JsonImport<T> = T extends string ? string : T extends readonly (infer U)[]
  ? JsonImport<U>[] : T extends object ? { [K in keyof T]: JsonImport<T[K]> } : T;
${sample.fixture ? `import body from ${fixturePath};\nconst imported: JsonImport<${sample.type === "SnoozeRequest" ? sample.type : `API.${sample.type}`}> = body;` : ""}
// A fresh literal enables excess-property checks: optional-field renames must
// not silently disappear through structural assignability.
const exact = ${JSON.stringify(sample.value)} satisfies ${sample.type === "SnoozeRequest" ? sample.type : `API.${sample.type}`};
`,
      );
    }
    writeFileSync(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          esModuleInterop: true,
          types: [],
        },
        include: ["*.ts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
        "--project",
        path.join(directory, "tsconfig.json"),
        "--pretty",
        "false",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (result.error) throw result.error;
    return { status: result.status, diagnostics: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("every Rust fixture imports and validates against the actual app API types", () => {
  expect(readdirSync(path.join(__dirname, "fixtures")).toSorted()).toEqual(
    Object.keys(bodies)
      .map((name) => `${name}.json`)
      .toSorted(),
  );
  const result = compile(
    Object.entries(bodies).map(([name, type]) => ({
      name,
      type,
      fixture: name,
      value: readFixture(name),
    })),
  );
  expect(result.diagnostics).toBe("");
  expect(result.status).toBe(0);
}, 40_000);

test("legacy responses may omit additive date, units and media fields", () => {
  const samples = [
    { name: "legacy-workout", type: "WorkoutResponse", value: { workout: null } },
    ...["me", "workout-open", "set-logged", "set-deleted", "workout-done", "plan"].map((name) => ({
      name: `legacy-${name}`,
      type: bodies[name],
      value: omitFields(readFixture(name), ["weight_unit", "weight", "unit", "media"]),
    })),
    {
      name: "legacy-status",
      type: bodies.status,
      value: omitFields(readFixture("status"), ["weight_unit"]),
    },
  ];
  const result = compile(samples);
  expect(result.diagnostics).toBe("");
  expect(result.status).toBe(0);
}, 40_000);

test("validation rejects type, field-name, enum, nullable and optional-field drift", () => {
  const samples = [
    {
      name: "wrong-type",
      type: "Health",
      value: { status: "ok", server_version: 123, min_app_version: "0.1.0" },
    },
    {
      name: "wrong-name",
      type: "Health",
      value: { status: "ok", serverVersion: "example", min_app_version: "0.1.0" },
    },
    {
      name: "wrong-enum",
      type: "Health",
      value: { status: "unknown", server_version: "example", min_app_version: "0.1.0" },
    },
    { name: "wrong-nullable", type: "WorkoutResponse", value: { workout: false } },
    {
      name: "wrong-optional-type",
      type: "ErrorBody",
      value: { error: "example", min_app_version: 123 },
    },
    {
      name: "wrong-optional-name",
      type: "WorkoutResponse",
      value: { workout: null, household_date: "2026-10-26" },
    },
    {
      name: "wrong-request-optional",
      type: "LogSetRequest",
      value: { exercise: "Example", weight: null, unit: "lb", reps: 8, performed_at: 123 },
    },
    {
      name: "wrong-plan-reason",
      type: "PlanResponse",
      value: { date: "2026-10-26", week_start: "2026-10-26", plan: null, reason: "unknown" },
    },
    {
      name: "wrong-media-name",
      type: "ExerciseMedia",
      value: { videoUrl: "/example/video", poster_url: "/example/poster" },
    },
    {
      name: "wrong-media-type",
      type: "PlannedExercise",
      value: { name: "Example", sets: 3, reps: "8", target: null, media: false },
    },
    {
      name: "wrong-display-unit",
      type: "Target",
      value: { weight_lb: 100, weight: 45, unit: "stone", reps: [8], note: null },
    },
    {
      name: "wrong-display-weight",
      type: "Target",
      value: { weight_lb: 100, weight: "45 kg", unit: "kg", reps: [8], note: null },
    },
  ];
  const result = compile(samples);
  expect(result.status).not.toBe(0);
  for (const sample of samples) expect(result.diagnostics).toContain(`${sample.name}.ts(`);
}, 40_000);
