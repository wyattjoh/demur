import { assert, describe, it } from "@effect/vitest";
import { decide, THRESHOLDS } from "./policy.ts";
import type { Judgments } from "./types.ts";

const safeJudgments: Judgments = {
  executesDestruction: 0,
  exposesSensitiveData: 0,
  weakensSecurityBoundary: 0,
  unrecoverable: 0,
  targetsSharedInfrastructure: 0,
  blastRadius: 0,
  blastRadiusConfidence: 1,
};

describe("command policy", () => {
  it("denies sensitive-data exposure even when the command is read-only", () => {
    const outcome = decide({
      ...safeJudgments,
      exposesSensitiveData: 1,
    });

    assert.strictEqual(outcome.decision, "deny");
    assert.include(outcome.reason, "sensitive data");
  });

  it("asks about borderline sensitive-data exposure before the inert gate", () => {
    const outcome = decide({
      ...safeJudgments,
      exposesSensitiveData: THRESHOLDS.denySensitiveDataExposure,
    });

    assert.strictEqual(outcome.decision, "ask");
    assert.include(outcome.reason, "sensitive values");
  });

  it("denies commands that weaken a security boundary", () => {
    const outcome = decide({
      ...safeJudgments,
      executesDestruction: 1,
      weakensSecurityBoundary: 1,
    });

    assert.strictEqual(outcome.decision, "deny");
    assert.include(outcome.reason, "security boundary");
  });

  it("still allows inert text when the new harmful-operation signals are low", () => {
    const outcome = decide(safeJudgments);

    assert.strictEqual(outcome.decision, "allow");
    assert.include(outcome.reason, "inert");
  });
});
