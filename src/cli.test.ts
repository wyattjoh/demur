import { assert, describe, it } from "@effect/vitest";
import type {
  TrainingRecord,
  TrainingReview,
  TrainingReviewInput,
} from "../extensions/demur/training-store.ts";
import { runCli, type CliDependencies } from "./cli.ts";
import type { ResolvedApiKey } from "./key.ts";
import type { TrainingReviewSnapshot } from "./training-review-model.ts";
import type { Verdict } from "./types.ts";

const allowedVerdict: Verdict = {
  decision: "allow",
  reason: "demur: safe",
  judgments: undefined,
  failure: undefined,
  latencyMs: 12,
  usage: undefined,
};

type CliState = {
  resolved: ResolvedApiKey | undefined;
  stored: string | undefined;
  deleted: boolean;
  promptCalls: number;
  judged: { command: string; cwd: string } | undefined;
  trainingRecords: Array<TrainingRecord>;
  trainingReviews: Array<TrainingReview>;
  recordedReviews: Array<TrainingReviewInput>;
  reviewInputs: Array<string>;
  interactive: boolean;
  tuiCalls: Array<TrainingReviewSnapshot>;
  tuiReloads: Array<TrainingReviewSnapshot>;
  stdout: Array<string>;
  stderr: Array<string>;
};

function makeDependencies(
  state: CliState,
  promptedValue = "prompted-key",
): CliDependencies {
  return {
    judge: async (command, cwd) => {
      state.judged = { command, cwd };
      return allowedVerdict;
    },
    resolveApiKey: async () => state.resolved,
    storeApiKey: async (value) => {
      state.stored = value;
    },
    deleteApiKey: async () => state.deleted,
    loadTrainingRecords: async () => state.trainingRecords,
    loadTrainingReviews: async () => state.trainingReviews,
    recordTrainingReview: async (input) => {
      state.recordedReviews.push(input);
      return {
        version: 1,
        reviewedAt: "2026-01-02T00:00:00.000Z",
        ...input,
      };
    },
    runTrainingReviewTui: async (snapshot, reloadSnapshot) => {
      state.tuiCalls.push(snapshot);
      state.tuiReloads.push(await reloadSnapshot());
      return {
        reviewed: snapshot.records.length,
        corrected: 0,
        skipped: 0,
      };
    },
    isInteractive: () => state.interactive,
    readSecret: async () => {
      state.promptCalls += 1;
      return promptedValue;
    },
    readLine: async () => state.reviewInputs.shift() ?? "quit",
    cwd: () => "/default",
    stdout: (message) => state.stdout.push(message),
    stderr: (message) => state.stderr.push(message),
  };
}

function makeState(
  resolved: ResolvedApiKey | undefined = undefined,
): CliState {
  return {
    resolved,
    stored: undefined,
    deleted: false,
    promptCalls: 0,
    judged: undefined,
    trainingRecords: [],
    trainingReviews: [],
    recordedReviews: [],
    reviewInputs: [],
    interactive: false,
    tuiCalls: [],
    tuiReloads: [],
    stdout: [],
    stderr: [],
  };
}

describe("demur CLI", () => {
  it("imports an environment key without prompting", async () => {
    const state = makeState({
      value: "environment-key",
      source: "environment",
    });

    const exitCode = await runCli(
      ["auth", "login"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(state.stored, "environment-key");
    assert.strictEqual(state.promptCalls, 0);
    assert.include(state.stdout.join("\n"), "TYPESAFE_API_KEY");
  });

  it("prompts for a key when no environment override exists", async () => {
    const state = makeState({ value: "old-key", source: "system" });

    const exitCode = await runCli(
      ["auth", "login"],
      makeDependencies(state, "new-key"),
    );

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(state.stored, "new-key");
    assert.strictEqual(state.promptCalls, 1);
  });

  it("reports the active credential source without printing the key", async () => {
    const state = makeState({ value: "do-not-print", source: "system" });

    const exitCode = await runCli(
      ["auth", "status"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.include(state.stdout.join("\n"), "operating system");
    assert.notInclude(state.stdout.join("\n"), "do-not-print");
  });

  it("warns when logout cannot remove an environment override", async () => {
    const state = makeState({
      value: "environment-key",
      source: "environment",
    });
    state.deleted = true;

    const exitCode = await runCli(
      ["auth", "logout"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.include(state.stdout.join("\n"), "unset separately");
  });

  it("reviews training records and persists corrected decisions", async () => {
    const state = makeState();
    state.trainingRecords.push({
      version: 1,
      id: "record-1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      command: "git reset --hard HEAD~1",
      cwd: "/workspace",
      mode: "passive",
      verdict: {
        ...allowedVerdict,
        decision: "allow",
        reason: "demur: judged safe",
      },
      hostAction: "allow",
    });
    state.reviewInputs.push("deny", "would destroy unpushed work");

    const exitCode = await runCli(
      ["training", "review"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.deepEqual(state.recordedReviews, [{
      recordId: "record-1",
      originalDecision: "allow",
      expectedDecision: "deny",
      note: "would destroy unpushed work",
    }]);
    assert.include(state.stdout.join("\n"), "ALLOW");
    assert.include(state.stdout.join("\n"), "1 corrected");
  });

  it("opens the central TUI for a bare interactive invocation", async () => {
    const state = makeState();
    state.interactive = true;

    const exitCode = await runCli([], makeDependencies(state));

    assert.strictEqual(exitCode, 0);
    assert.deepEqual(state.tuiCalls, [{ records: [], reviews: [] }]);
    assert.include(state.stdout.join("\n"), "Reviewed 0 records");
  });

  it("rejects a bare invocation without an interactive terminal", async () => {
    const state = makeState();

    const exitCode = await runCli([], makeDependencies(state));

    assert.strictEqual(exitCode, 2);
    assert.strictEqual(state.tuiCalls.length, 0);
    assert.include(state.stderr.join("\n"), "requires a terminal");
    assert.include(state.stderr.join("\n"), "--plain");
  });

  it("opens the TUI by default on an interactive terminal", async () => {
    const state = makeState();
    state.interactive = true;
    state.trainingRecords.push({
      version: 1,
      id: "record-1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      command: "printf ok",
      cwd: "/workspace",
      mode: "passive",
      verdict: allowedVerdict,
      hostAction: "allow",
    });

    const exitCode = await runCli(
      ["training", "review"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(state.tuiCalls.length, 1);
    assert.strictEqual(state.tuiCalls[0]?.records[0]?.id, "record-1");
    assert.strictEqual(state.tuiReloads[0]?.records[0]?.id, "record-1");
    assert.include(state.stdout.join("\n"), "Reviewed 1 record");
  });

  it("opens an empty TUI that can reload new records", async () => {
    const state = makeState();
    state.interactive = true;

    const exitCode = await runCli(
      ["training", "review"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.deepEqual(state.tuiCalls, [{ records: [], reviews: [] }]);
    assert.deepEqual(state.tuiReloads, [{ records: [], reviews: [] }]);
    assert.notInclude(state.stdout.join("\n"), "No unreviewed");
    assert.include(state.stdout.join("\n"), "Reviewed 0 records");
  });

  it("uses the plain reviewer when explicitly requested", async () => {
    const state = makeState();
    state.interactive = true;
    state.trainingRecords.push({
      version: 1,
      id: "record-1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      command: "printf ok",
      cwd: "/workspace",
      mode: "passive",
      verdict: allowedVerdict,
      hostAction: "allow",
    });
    state.reviewInputs.push("");

    const exitCode = await runCli(
      ["training", "review", "--plain"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(state.tuiCalls.length, 0);
    assert.strictEqual(state.recordedReviews[0]?.expectedDecision, "allow");
  });

  it("skips records that already have a review", async () => {
    const state = makeState();
    state.trainingRecords.push({
      version: 1,
      id: "record-1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      command: "printf ok",
      cwd: "/workspace",
      mode: "enforce",
      verdict: allowedVerdict,
      hostAction: "allow",
    });
    state.trainingReviews.push({
      version: 1,
      recordId: "record-1",
      reviewedAt: "2026-01-02T00:00:00.000Z",
      originalDecision: "allow",
      expectedDecision: "allow",
      note: undefined,
    });

    const exitCode = await runCli(
      ["training", "review"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.include(state.stdout.join("\n"), "No unreviewed");
    assert.deepEqual(state.recordedReviews, []);
  });

  it("preserves the judge command and cwd option", async () => {
    const state = makeState();

    const exitCode = await runCli(
      ["judge", "git", "reset", "--hard", "--cwd=/workspace"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(state.judged, {
      command: "git reset",
      cwd: "/workspace",
    });
    assert.include(state.stdout.join("\n"), "ALLOW");
  });
});
