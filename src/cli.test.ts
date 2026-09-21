import { assert, describe, it } from "@effect/vitest";
import type { DemurSettings } from "../extensions/demur/settings.ts";
import type {
  TrainingRecord,
  TrainingReview,
  TrainingReviewInput,
} from "../extensions/demur/training-store.ts";
import { runCli, type CliDependencies } from "./cli.ts";
import type { ResolvedApiKey } from "./key.ts";
import type { TrainingReviewSnapshot } from "./training-review-model.ts";
import type { RenderedCommandState, Verdict } from "./types.ts";

const allowedVerdict: Verdict = {
  decision: "allow",
  reason: "demur: safe",
  judgments: undefined,
  failure: undefined,
  latencyMs: 12,
  usage: undefined,
};

function makeTrainingRecord(
  id: string,
  command: string,
  cwd: string,
  decision: Verdict["decision"] = "allow",
): TrainingRecord {
  return {
    version: 1,
    id,
    recordedAt: "2026-01-01T00:00:00.000Z",
    command,
    cwd,
    mode: "passive",
    verdict: { ...allowedVerdict, decision },
    hostAction: "allow",
  };
}

function makeReplayableTrainingRecord(
  id: string,
  command: string,
  cwd: string,
): TrainingRecord {
  return {
    version: 2,
    id,
    recordedAt: "2026-01-01T00:00:00.000Z",
    command,
    cwd,
    mode: "passive",
    verdict: { ...allowedVerdict },
    evidence: {
      modelState: {
        command,
        working_directory: cwd,
        requesting_agent: "pi",
        version_control: "Not inside a git repository.",
      },
      analysis: undefined,
      model: "jev-latest",
      questionSetVersion: 1,
      policyVersion: 1,
      policyThresholds: { executesDestruction: 0.3 },
    },
    hostAction: "allow",
  };
}

type CliState = {
  resolved: ResolvedApiKey | undefined;
  stored: string | undefined;
  deleted: boolean;
  promptCalls: number;
  judged: { command: string; cwd: string } | undefined;
  judgedTrainingStates: Array<RenderedCommandState>;
  trainingRecords: Array<TrainingRecord>;
  trainingReviews: Array<TrainingReview>;
  globalEstimatedCostUsd: number;
  recordedReviews: Array<TrainingReviewInput>;
  interactive: boolean;
  settings: DemurSettings;
  savedSettings: Array<DemurSettings>;
  tuiCalls: Array<TrainingReviewSnapshot>;
  tuiReloads: Array<TrainingReviewSnapshot>;
  tuiSettings: Array<DemurSettings>;
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
    judgeTrainingState: async (renderedState) => {
      state.judgedTrainingStates.push(renderedState);
      return {
        ok: true,
        judgments: {
          executesDestruction: 0,
          exposesSensitiveData: 0,
          weakensSecurityBoundary: 0,
          unrecoverable: 0,
          targetsSharedInfrastructure: 0,
          blastRadius: 0,
          blastRadiusConfidence: 1,
        },
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    },
    resolveApiKey: async () => state.resolved,
    storeApiKey: async (value) => {
      state.stored = value;
    },
    deleteApiKey: async () => state.deleted,
    loadTrainingRecords: async () => state.trainingRecords,
    loadTrainingReviews: async () => state.trainingReviews,
    loadGlobalEstimatedCostUsd: async () => state.globalEstimatedCostUsd,
    recordTrainingReview: async (input) => {
      state.recordedReviews.push(input);
      return {
        version: 2,
        reviewedAt: "2026-01-02T00:00:00.000Z",
        ...input,
      };
    },
    loadDemurSettings: async () => state.settings,
    saveDemurSettings: async (settings) => {
      state.savedSettings.push(settings);
    },
    runTrainingReviewTui: async (snapshot, settings, reloadSnapshot) => {
      state.tuiCalls.push(snapshot);
      state.tuiSettings.push(settings);
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
    judgedTrainingStates: [],
    trainingRecords: [],
    trainingReviews: [],
    globalEstimatedCostUsd: 0,
    recordedReviews: [],
    interactive: false,
    settings: {
      mode: "enforce",
      training: false,
      failurePolicy: "block",
    },
    savedSettings: [],
    tuiCalls: [],
    tuiReloads: [],
    tuiSettings: [],
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

  it("lists training records with status and cwd filters", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeTrainingRecord("record-1", "printf ok", "/workspace/app"),
      makeTrainingRecord("record-2", "git reset --hard", "/archive", "deny"),
    );

    const exitCode = await runCli(
      ["training", "list", "--status=unreviewed", "--cwd", "workspace"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.include(state.stdout.join("\n"), "record-1");
    assert.include(state.stdout.join("\n"), "model=allow");
    assert.notInclude(state.stdout.join("\n"), "record-2");
  });

  it("lists complete filtered history as one JSON document", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeTrainingRecord("record-1", "printf ok", "/workspace"),
      makeTrainingRecord("record-2", "git reset --hard", "/workspace"),
    );
    state.trainingReviews.push({
      version: 1,
      recordId: "record-2",
      reviewedAt: "2026-01-02T00:00:00.000Z",
      originalDecision: "allow",
      expectedDecision: "deny",
      note: "destructive",
    });

    const exitCode = await runCli(
      ["training", "list", "--status", "deny", "--json"],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(state.stdout.length, 1);
    assert.strictEqual(payload.version, 1);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.operation, "training.list");
    assert.strictEqual(payload.result.records.length, 1);
    assert.strictEqual(payload.result.records[0].record.id, "record-2");
    assert.strictEqual(payload.result.records[0].status, "deny");
    assert.strictEqual(
      payload.result.records[0].latestReview.expectedDecision,
      "deny",
    );
  });

  it("reviews a record by ID with decision and note flags", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeTrainingRecord(
        "record-1",
        "git reset --hard HEAD~1",
        "/workspace",
      ),
    );

    const exitCode = await runCli(
      [
        "training",
        "review",
        "record-1",
        "--decision",
        "deny",
        "--reason=recoverability",
        "--note=would destroy unpushed work",
      ],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 0);
    assert.deepEqual(state.recordedReviews, [{
      recordId: "record-1",
      originalDecision: "allow",
      expectedDecision: "deny",
      correctionReason: "recoverability",
      note: "would destroy unpushed work",
    }]);
    assert.include(state.stdout.join("\n"), "Recorded DENY review");
  });

  it("requires a structured reason for corrected reviews", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeTrainingRecord("record-1", "printf ok", "/workspace"),
    );

    const exitCode = await runCli(
      [
        "training",
        "review",
        "record-1",
        "--decision=deny",
        "--json",
      ],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 2);
    assert.strictEqual(payload.ok, false);
    assert.include(payload.error.message, "require `--reason`");
    assert.deepEqual(state.recordedReviews, []);
  });

  it("evaluates reviewed judgments without another model call", async () => {
    const state = makeState();
    const record = makeTrainingRecord("record-1", "printf ok", "/workspace");
    record.verdict.judgments = {
      executesDestruction: 0,
      exposesSensitiveData: 0,
      weakensSecurityBoundary: 0,
      unrecoverable: 0,
      targetsSharedInfrastructure: 0,
      blastRadius: 0,
      blastRadiusConfidence: 1,
    };
    state.trainingRecords.push(record);
    state.trainingReviews.push({
      version: 2,
      recordId: "record-1",
      reviewedAt: "2026-01-02T00:00:00.000Z",
      originalDecision: "allow",
      expectedDecision: "allow",
      correctionReason: undefined,
      note: undefined,
    });

    const exitCode = await runCli(
      ["training", "evaluate", "--json"],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(payload.operation, "training.evaluate");
    assert.strictEqual(payload.result.current.matches, 1);
    assert.strictEqual(payload.result.current.weightedLoss, 0);
    assert.strictEqual(state.judged, undefined);
    assert.deepEqual(state.judgedTrainingStates, []);
  });

  it("explicitly replays exact captured state through current questions", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeReplayableTrainingRecord("record-1", "printf ok", "/workspace"),
    );
    state.trainingReviews.push({
      version: 2,
      recordId: "record-1",
      reviewedAt: "2026-01-02T00:00:00.000Z",
      originalDecision: "allow",
      expectedDecision: "allow",
      correctionReason: undefined,
      note: undefined,
    });

    const exitCode = await runCli(
      ["training", "evaluate", "--replay", "--json"],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(payload.result.replay.metrics.matches, 1);
    assert.strictEqual(payload.result.replay.inputTokens, 10);
    assert.deepEqual(state.judgedTrainingStates, [{
      command: "printf ok",
      working_directory: "/workspace",
      requesting_agent: "pi",
      version_control: "Not inside a git repository.",
    }]);
  });

  it("preserves a note when accepting the model decision", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeTrainingRecord("record-1", "printf ok", "/workspace"),
    );

    const exitCode = await runCli(
      [
        "training",
        "review",
        "record-1",
        "--decision=allow",
        "--note=verified read-only operation",
        "--json",
      ],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(
      state.recordedReviews[0]?.note,
      "verified read-only operation",
    );
    assert.strictEqual(
      payload.result.review.note,
      "verified read-only operation",
    );
  });

  it("returns a versioned JSON review result with prior revision", async () => {
    const state = makeState();
    state.trainingRecords.push(
      makeTrainingRecord("record-1", "printf ok", "/workspace"),
    );
    state.trainingReviews.push({
      version: 1,
      recordId: "record-1",
      reviewedAt: "2026-01-01T12:00:00.000Z",
      originalDecision: "allow",
      expectedDecision: "allow",
      note: undefined,
    });

    const exitCode = await runCli(
      [
        "training",
        "review",
        "record-1",
        "--decision=ask",
        "--reason=missing-context",
        "--note",
        "needs confirmation",
        "--json",
      ],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(state.stdout.length, 1);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.operation, "training.review");
    assert.strictEqual(payload.result.review.expectedDecision, "ask");
    assert.strictEqual(payload.result.review.note, "needs confirmation");
    assert.strictEqual(
      payload.result.previousReview.expectedDecision,
      "allow",
    );
  });

  it("returns machine-readable review errors", async () => {
    const state = makeState();

    const exitCode = await runCli(
      [
        "training",
        "review",
        "missing",
        "--decision=deny",
        "--json",
      ],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 1);
    assert.strictEqual(state.stderr.length, 0);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.error.code, "record_not_found");
  });

  it("opens the central TUI for a bare interactive invocation", async () => {
    const state = makeState();
    state.interactive = true;

    const exitCode = await runCli([], makeDependencies(state));

    assert.strictEqual(exitCode, 0);
    assert.deepEqual(state.tuiCalls, [{
      records: [],
      reviews: [],
      globalEstimatedCostUsd: 0,
    }]);
    assert.deepEqual(state.tuiSettings, [{
      mode: "enforce",
      training: false,
      failurePolicy: "block",
    }]);
    assert.include(state.stdout.join("\n"), "Reviewed 0 records");
  });

  it("rejects a bare invocation without an interactive terminal", async () => {
    const state = makeState();

    const exitCode = await runCli([], makeDependencies(state));

    assert.strictEqual(exitCode, 2);
    assert.strictEqual(state.tuiCalls.length, 0);
    assert.include(state.stderr.join("\n"), "requires a terminal");
    assert.include(state.stderr.join("\n"), "training list --json");
  });

  it("opens the TUI by default on an interactive terminal", async () => {
    const state = makeState();
    state.interactive = true;
    state.globalEstimatedCostUsd = 0.000_088_368;
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
    assert.strictEqual(
      state.tuiCalls[0]?.globalEstimatedCostUsd,
      0.000_088_368,
    );
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
    assert.deepEqual(state.tuiCalls, [{
      records: [],
      reviews: [],
      globalEstimatedCostUsd: 0,
    }]);
    assert.deepEqual(state.tuiReloads, [{
      records: [],
      reviews: [],
      globalEstimatedCostUsd: 0,
    }]);
    assert.notInclude(state.stdout.join("\n"), "No unreviewed");
    assert.include(state.stdout.join("\n"), "Reviewed 0 records");
  });

  it("rejects interactive review without a terminal", async () => {
    const state = makeState();

    const exitCode = await runCli(
      ["training", "review"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 2);
    assert.strictEqual(state.tuiCalls.length, 0);
    assert.include(state.stderr.join("\n"), "requires a terminal");
    assert.include(state.stderr.join("\n"), "review a record by ID");
  });

  it("rejects the removed plain flag", async () => {
    const state = makeState();

    const exitCode = await runCli(
      ["training", "review", "--plain"],
      makeDependencies(state),
    );

    assert.strictEqual(exitCode, 2);
    assert.strictEqual(state.recordedReviews.length, 0);
    assert.include(state.stderr.join("\n"), "unknown option: --plain");
  });

  it("returns JSON argument errors without human usage output", async () => {
    const state = makeState();

    const exitCode = await runCli(
      ["training", "list", "--status=unknown", "--json"],
      makeDependencies(state),
    );

    const payload = JSON.parse(state.stdout[0] ?? "");
    assert.strictEqual(exitCode, 2);
    assert.strictEqual(state.stderr.length, 0);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.error.code, "invalid_arguments");
    assert.include(payload.error.message, "unsupported status");
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
