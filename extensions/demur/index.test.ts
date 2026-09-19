import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import { estimateInputCostUsd } from "./cost-tracker.ts";
import {
  formatEvaluationDuration,
  formatRunNotification,
} from "./index.ts";

const execFilePromise = promisify(execFile);
const extensionUrl = new URL("./index.ts", import.meta.url).href;

describe("Pi extension", () => {
  it("formats the published Jev input-cost estimate", () => {
    assert.strictEqual(estimateInputCostUsd(1_000_000), 0.042);
    assert.strictEqual(
      formatRunNotification("ALLOW", 742, 0.000088368, 512.4),
      "demur: ALLOW · 742 input tokens · estimated cost $0.000031164 · accumulated $0.000088368 · evaluated in 512 ms",
    );
    assert.strictEqual(
      formatRunNotification("ERROR", undefined, undefined, 1_234),
      "demur: ERROR · cost unavailable · evaluated in 1.23 s",
    );
  });

  it("formats evaluation time using reasonable units", () => {
    assert.strictEqual(formatEvaluationDuration(0.4), "<1 ms");
    assert.strictEqual(formatEvaluationDuration(74.6), "75 ms");
    assert.strictEqual(formatEvaluationDuration(1_234), "1.23 s");
    assert.strictEqual(formatEvaluationDuration(12_340), "12.3 s");
    assert.strictEqual(formatEvaluationDuration(62_400), "1m 2.4s");
  });

  it("runs the Bun-native guard from a Node host", async () => {
    const script = [
      `const { runGuardWorker } = await import(${JSON.stringify(extensionUrl)});`,
      'const verdict = await runGuardWorker("printf ok", process.cwd(), undefined);',
      "process.stdout.write(JSON.stringify(verdict));",
    ].join("\n");
    const { stdout } = await execFilePromise(
      "node",
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, DEMUR_DISABLE: "1" },
      },
    );
    const verdict = JSON.parse(stdout) as {
      decision: string;
      reason: string;
    };

    assert.strictEqual(verdict.decision, "allow");
    assert.include(verdict.reason, "disabled via DEMUR_DISABLE");
  });
});
