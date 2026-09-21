import { assert, describe, it } from "@effect/vitest";
import type {
  TrainingRecord,
  TrainingReview,
} from "../extensions/demur/training-store.ts";
import {
  buildTrainingReviewEntries,
  createTrainingReviewInput,
  filterTrainingReviewEntries,
  getLatestTrainingReview,
  getTrainingReviewFilter,
} from "./training-review-model.ts";

function trainingRecord(id: string, cwd: string): TrainingRecord {
  return {
    version: 1,
    id,
    recordedAt: `2026-01-0${id.length}T00:00:00.000Z`,
    command: `printf ${id}`,
    cwd,
    mode: "passive",
    verdict: {
      decision: "allow",
      reason: "demur: judged safe",
      judgments: undefined,
      failure: undefined,
      latencyMs: 42,
      usage: undefined,
    },
    hostAction: "allow",
  };
}

function trainingReview(
  recordId: string,
  expectedDecision: "allow" | "ask" | "deny",
  reviewedAt: string,
): TrainingReview {
  return {
    version: 1,
    recordId,
    reviewedAt,
    originalDecision: "allow",
    expectedDecision,
    note: undefined,
  };
}

describe("training review model", () => {
  it("keeps complete history while the latest review determines status", () => {
    const entries = buildTrainingReviewEntries({
      records: [trainingRecord("record-1", "/workspace")],
      reviews: [
        trainingReview("record-1", "allow", "2026-01-02T00:00:00.000Z"),
        trainingReview("record-1", "deny", "2026-01-03T00:00:00.000Z"),
      ],
      globalEstimatedCostUsd: 0,
    });

    assert.strictEqual(entries[0]?.reviews.length, 2);
    assert.strictEqual(
      getLatestTrainingReview(entries[0]!)?.expectedDecision,
      "deny",
    );
    assert.strictEqual(getTrainingReviewFilter(entries[0]!), "deny");
  });

  it("filters historical entries by their latest answer", () => {
    const entries = buildTrainingReviewEntries({
      records: [
        trainingRecord("first", "/workspace/first"),
        trainingRecord("second", "/workspace/second"),
        trainingRecord("third", "/workspace/third"),
      ],
      reviews: [
        trainingReview("first", "allow", "2026-01-02T00:00:00.000Z"),
        trainingReview("second", "ask", "2026-01-02T00:00:00.000Z"),
      ],
      globalEstimatedCostUsd: 0,
    });

    assert.deepEqual(
      filterTrainingReviewEntries(entries, "all", "")
        .map((entry) => entry.record.id),
      ["first", "second", "third"],
    );
    assert.deepEqual(
      filterTrainingReviewEntries(entries, "allow", "")
        .map((entry) => entry.record.id),
      ["first"],
    );
    assert.deepEqual(
      filterTrainingReviewEntries(entries, "ask", "")
        .map((entry) => entry.record.id),
      ["second"],
    );
    assert.deepEqual(
      filterTrainingReviewEntries(entries, "unreviewed", "")
        .map((entry) => entry.record.id),
      ["third"],
    );
  });

  it("fuzzy-searches working directories and ranks compact matches first", () => {
    const entries = buildTrainingReviewEntries({
      records: [
        trainingRecord("compact", "/workspace/demur"),
        trainingRecord("spread", "/work/deep-module-router"),
        trainingRecord("missing", "/tmp/unmatched"),
      ],
      reviews: [],
      globalEstimatedCostUsd: 0,
    });

    assert.deepEqual(
      filterTrainingReviewEntries(entries, "unreviewed", "dmr")
        .map((entry) => entry.record.id),
      ["compact", "spread"],
    );
  });

  it("normalizes notes for accepted and corrected review revisions", () => {
    const record = trainingRecord("record-1", "/workspace");

    assert.deepEqual(
      createTrainingReviewInput(
        record,
        "allow",
        "  verified read-only operation  ",
      ),
      {
        recordId: "record-1",
        originalDecision: "allow",
        expectedDecision: "allow",
        note: "verified read-only operation",
      },
    );
    assert.deepEqual(
      createTrainingReviewInput(
        record,
        "deny",
        "  would destroy unpushed work  ",
      ),
      {
        recordId: "record-1",
        originalDecision: "allow",
        expectedDecision: "deny",
        note: "would destroy unpushed work",
      },
    );
  });
});
