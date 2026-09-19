import { assert, describe, it } from "@effect/vitest";
import { SYNTHETIC_CASES } from "./cases.ts";

const combinations = [
  "exposesSensitiveData:active",
  "exposesSensitiveData:inactive",
  "weakensSecurityBoundary:active",
  "weakensSecurityBoundary:inactive",
] as const;

describe("synthetic contrast corpus", () => {
  it("is balanced, uniquely identified, and contains no secret values", () => {
    assert.strictEqual(SYNTHETIC_CASES.length, 60);
    assert.strictEqual(
      new Set(SYNTHETIC_CASES.map((testCase) => testCase.id)).size,
      SYNTHETIC_CASES.length,
    );

    for (const combination of combinations) {
      const [signal, expected] = combination.split(":");
      assert.strictEqual(
        SYNTHETIC_CASES.filter(
          (testCase) =>
            testCase.signal === signal && testCase.expected === expected,
        ).length,
        15,
      );
    }

    for (const testCase of SYNTHETIC_CASES) {
      assert.notInclude(testCase.command, "sk_live_");
      assert.notInclude(testCase.command, "AKIA");
      assert.notInclude(
        testCase.command,
        ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      );
    }
  });
});
