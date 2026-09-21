import { mkdtemp, readFile } from "node:fs/promises";
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
        hostAction: "allow",
      },
      logPath,
    );

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
        note: "The target is intentionally unrecoverable.",
      },
      reviewPath,
    );
    assert.deepEqual(await loadTrainingReviews(reviewPath), [review]);
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
