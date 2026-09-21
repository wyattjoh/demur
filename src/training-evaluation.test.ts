import { assert, describe, it } from "@effect/vitest";
import type {
  TrainingRecordV2,
  TrainingReview,
} from "../extensions/demur/training-store.ts";
import { analyze } from "./analyze.ts";
import { THRESHOLDS } from "./policy.ts";
import {
  analyzeTrainingFeedback,
  evaluateThresholds,
  replayTrainingQuestions,
} from "./training-evaluation.ts";
import { buildTrainingReviewEntries } from "./training-review-model.ts";
import type { Decision, Judgments } from "./types.ts";

const safeJudgments: Judgments = {
  executesDestruction: 0,
  exposesSensitiveData: 0,
  weakensSecurityBoundary: 0,
  unrecoverable: 0,
  targetsSharedInfrastructure: 0,
  blastRadius: 0,
  blastRadiusConfidence: 1,
};

function record(
  id: string,
  judgments: Judgments,
  decision: Decision,
): TrainingRecordV2 {
  return {
    version: 2,
    id,
    recordedAt: "2026-01-01T00:00:00.000Z",
    command: `printf ${id}`,
    cwd: "/workspace",
    mode: "passive",
    verdict: {
      decision,
      reason: "synthetic training verdict",
      judgments,
      failure: undefined,
      latencyMs: 10,
      usage: undefined,
    },
    evidence: {
      modelState: { command: `printf ${id}` },
      analysis: analyze(`printf ${id}`, "/workspace", "/home/test", "/tmp"),
      model: "jev-latest",
      questionSetVersion: 1,
      policyVersion: 1,
      policyThresholds: { ...THRESHOLDS },
    },
    hostAction: "allow",
  };
}

function review(
  recordId: string,
  originalDecision: Decision,
  expectedDecision: Decision,
): TrainingReview {
  return {
    version: 2,
    recordId,
    reviewedAt: "2026-01-02T00:00:00.000Z",
    originalDecision,
    expectedDecision,
    correctionReason: originalDecision === expectedDecision
      ? undefined
      : "sensitive-data",
    note: undefined,
  };
}

describe("training feedback evaluation", () => {
  it("replays raw judgments through the shared policy", () => {
    const entries = buildTrainingReviewEntries({
      records: [record("safe", safeJudgments, "allow")],
      reviews: [review("safe", "allow", "allow")],
      globalEstimatedCostUsd: 0,
    });

    const metrics = evaluateThresholds(entries, THRESHOLDS);

    assert.strictEqual(metrics.matches, 1);
    assert.strictEqual(metrics.weightedLoss, 0);
    assert.strictEqual(metrics.matrix.allow.allow, 1);
  });

  it("clusters corrections and finds lower-loss single-threshold candidates", () => {
    const missedSensitiveData = {
      ...safeJudgments,
      exposesSensitiveData: 0.4,
    };
    const entries = buildTrainingReviewEntries({
      records: [
        record("safe", safeJudgments, "allow"),
        record("missed", missedSensitiveData, "allow"),
      ],
      reviews: [
        review("safe", "allow", "allow"),
        review("missed", "allow", "deny"),
      ],
      globalEstimatedCostUsd: 0,
    });

    const report = analyzeTrainingFeedback(entries);

    assert.strictEqual(report.completeReplayRecords, 2);
    assert.strictEqual(report.current.weightedLoss, 20);
    assert.strictEqual(report.correctionsByReason["sensitive-data"], 1);
    assert.isTrue(
      report.candidates.some((candidate) =>
        candidate.field === "denySensitiveDataExposure" &&
        candidate.metrics.weightedLoss < report.current.weightedLoss
      ),
    );
    assert.isDefined(report.warning);
  });

  it("replays captured state without executing candidate commands", async () => {
    const original = record("corrected", {
      ...safeJudgments,
      executesDestruction: 1,
      unrecoverable: 1,
    }, "deny");
    const second = record("second", safeJudgments, "allow");
    const entries = buildTrainingReviewEntries({
      records: [original, second],
      reviews: [
        review("corrected", "deny", "allow"),
        review("second", "allow", "allow"),
      ],
      globalEstimatedCostUsd: 0,
    });
    const seenStates: Array<unknown> = [];

    const report = await replayTrainingQuestions(
      entries,
      async (state) => {
        seenStates.push(state);
        return {
          ok: true,
          judgments: safeJudgments,
          usage: { inputTokens: 12, outputTokens: 3 },
        };
      },
      1,
      THRESHOLDS,
    );

    assert.deepEqual(seenStates, [original.evidence?.modelState]);
    assert.strictEqual(report.metrics.matches, 1);
    assert.strictEqual(report.improved, 1);
    assert.strictEqual(report.regressed, 0);
    assert.strictEqual(report.skipped, 1);
    assert.strictEqual(report.inputTokens, 12);
  });

  it("reports reviewed failures as unavailable", () => {
    const failed = record("failed", safeJudgments, "deny");
    failed.verdict.judgments = undefined;
    const entries = buildTrainingReviewEntries({
      records: [failed],
      reviews: [review("failed", "deny", "allow")],
      globalEstimatedCostUsd: 0,
    });

    const report = analyzeTrainingFeedback(entries);

    assert.strictEqual(report.reviewed, 1);
    assert.strictEqual(report.evaluable, 0);
    assert.strictEqual(report.unavailable, 1);
  });
});
