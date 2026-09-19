import { assert, describe, it } from "@effect/vitest";
import type { SyntheticEvalCase } from "./evaluate.ts";
import { makeSyntheticState, parseRunCount } from "./run.ts";

const testCase: SyntheticEvalCase = {
  id: "safe-fixture",
  command: "cat synthetic-credentials.env",
  description: "fixture command",
  signal: "exposesSensitiveData",
  expected: "active",
};

describe("synthetic eval runner", () => {
  it("builds isolated state without executing the fixture command", () => {
    const state = makeSyntheticState(testCase, 2);

    assert.strictEqual(state.command, testCase.command);
    assert.strictEqual(state.cwd, "/workspace/synthetic-demur-project");
    assert.strictEqual(state.git?.uncommittedFileCount, 0);
    assert.strictEqual(state.git?.untrackedFileCount, 0);
    assert.strictEqual(state.git?.unpushedCommitCount, 0);
    assert.include(state.nonce ?? "", "safe-fixture:2:");
    assert.isDefined(state.analysis);
  });

  it("accepts a configurable positive repeat count", () => {
    assert.strictEqual(parseRunCount([]), 1);
    assert.strictEqual(parseRunCount(["--runs=3"]), 3);
    assert.throws(() => parseRunCount(["--runs=0"]), "positive integer");
    assert.throws(() => parseRunCount(["--runs=11"]), "at most 10");
    assert.throws(() => parseRunCount(["--unknown"]), "Unknown option");
  });
});
