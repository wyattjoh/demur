import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { Verdict } from "../../src/types.ts";
import {
  getTrainingLogPath,
  getTrainingReviewPath,
  loadTrainingRecords,
  loadTrainingReviews,
  recordTrainingEvaluation,
  recordTrainingReview,
} from "./training-store.ts";

const evidence = {
  modelState: {
    command: "git reset --hard HEAD~1",
    working_directory: "/workspace",
    requesting_agent: "pi",
  },
  analysis: undefined,
  model: "jev-latest",
  questionSetVersion: 1,
  policyVersion: 1,
  policyThresholds: { executesDestruction: 0.3 },
} as const;

const verdict: Verdict = {
  decision: "ask",
  reason: "demur: uncertain target",
  judgments: {
    executesDestruction: 0.8,
    exposesSensitiveData: 0.1,
    weakensSecurityBoundary: 0.1,
    unrecoverable: 0.4,
    targetsSharedInfrastructure: 0.1,
    blastRadius: 1,
    blastRadiusConfidence: 0.9,
  },
  failure: undefined,
  latencyMs: 612,
  usage: { inputTokens: 742, outputTokens: 14 },
};

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Pi training store", () => {
  it("resolves global state paths with demur-specific precedence", () => {
    assert.strictEqual(
      getTrainingLogPath(
        {
          DEMUR_STATE_HOME: "/isolated/demur-state",
          XDG_STATE_HOME: "/state",
        },
        "/home/test",
      ),
      "/isolated/demur-state/training.jsonl",
    );
    assert.strictEqual(
      getTrainingLogPath({ XDG_STATE_HOME: "/state" }, "/home/test"),
      "/state/demur/training.jsonl",
    );
    assert.strictEqual(
      getTrainingReviewPath({}, "/home/test"),
      "/home/test/.local/state/demur/training-reviews.jsonl",
    );
  });

  it("appends complete evaluations and human reviews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-training-"));
    const logPath = join(directory, "training.jsonl");
    const reviewPath = join(directory, "training-reviews.jsonl");

    const first = await recordTrainingEvaluation(
      {
        command: "git reset --hard HEAD~1",
        cwd: "/workspace",
        mode: "passive",
        verdict,
        evidence,
        hostAction: "allow",
      },
      logPath,
    );
    const second = await recordTrainingEvaluation(
      {
        command: "printf ok",
        cwd: "/workspace",
        mode: "enforce",
        verdict: { ...verdict, decision: "allow" },
        evidence,
        hostAction: "allow",
      },
      logPath,
    );

    assert.strictEqual(first.version, 2);
    assert.deepEqual(first.evidence, evidence);
    assert.deepEqual(await loadTrainingRecords(logPath), [first, second]);
    const firstJsonLine = (await readFile(logPath, "utf8")).split("\n")[0];
    const persisted = JSON.parse(firstJsonLine ?? "") as {
      verdict: { failure: unknown; usage: unknown };
    };
    assert.strictEqual(persisted.verdict.failure, null);
    assert.deepEqual(persisted.verdict.usage, {
      inputTokens: 742,
      outputTokens: 14,
    });

    const review = await recordTrainingReview(
      {
        recordId: first.id,
        originalDecision: "ask",
        expectedDecision: "deny",
        correctionReason: "recoverability",
        note: "The target is intentionally unrecoverable.",
      },
      reviewPath,
    );
    assert.strictEqual(review.version, 2);
    assert.strictEqual(review.correctionReason, "recoverability");
    assert.deepEqual(await loadTrainingReviews(reviewPath), [review]);
  });

  it("requires structured reasons only for corrected reviews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-training-"));
    const reviewPath = join(directory, "training-reviews.jsonl");

    assert.match(
      await rejectionMessage(
        recordTrainingReview(
          {
            recordId: "record-1",
            originalDecision: "allow",
            expectedDecision: "deny",
            correctionReason: undefined,
            note: undefined,
          },
          reviewPath,
        ),
      ),
      /require a correction reason/,
    );
    assert.match(
      await rejectionMessage(
        recordTrainingReview(
          {
            recordId: "record-1",
            originalDecision: "allow",
            expectedDecision: "allow",
            correctionReason: "inert-or-read-only",
            note: undefined,
          },
          reviewPath,
        ),
      ),
      /cannot have a correction reason/,
    );
  });

  it("loads legacy version-one records and reviews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-training-"));
    const logPath = join(directory, "training.jsonl");
    const reviewPath = join(directory, "training-reviews.jsonl");
    const legacyRecord = {
      version: 1,
      id: "legacy-record",
      recordedAt: "2026-01-01T00:00:00.000Z",
      command: "printf legacy",
      cwd: "/workspace",
      mode: "passive",
      verdict,
      hostAction: "allow",
    } as const;
    const legacyReview = {
      version: 1,
      recordId: "legacy-record",
      reviewedAt: "2026-01-02T00:00:00.000Z",
      originalDecision: "ask",
      expectedDecision: "allow",
      note: null,
    } as const;

    await writeFile(logPath, `${JSON.stringify(legacyRecord)}\n`, "utf8");
    await writeFile(reviewPath, `${JSON.stringify(legacyReview)}\n`, "utf8");

    assert.deepEqual(await loadTrainingRecords(logPath), [legacyRecord]);
    assert.deepEqual(await loadTrainingReviews(reviewPath), [{
      ...legacyReview,
      note: undefined,
    }]);
  });

  it("serializes concurrent writers as complete JSON lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-training-"));
    const logPath = join(directory, "training.jsonl");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordTrainingEvaluation(
          {
            command: `printf ${index}`,
            cwd: "/workspace",
            mode: "passive",
            verdict,
            evidence,
            hostAction: "allow",
          },
          logPath,
        )
      ),
    );

    const records = await loadTrainingRecords(logPath);
    assert.strictEqual(records.length, 8);
    assert.deepEqual(
      new Set(records.map((record) => record.command)),
      new Set(Array.from({ length: 8 }, (_, index) => `printf ${index}`)),
    );
  });
});
