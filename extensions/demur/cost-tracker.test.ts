import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import {
  estimateInputCostUsd,
  getCostStatePath,
  recordInputCost,
  type CostTotals,
} from "./cost-tracker.ts";

const execFilePromise = promisify(execFile);
const trackerUrl = new URL("./cost-tracker.ts", import.meta.url).href;

describe("Pi cost tracker", () => {
  it("resolves the global XDG state path", () => {
    assert.strictEqual(
      getCostStatePath({ XDG_STATE_HOME: "/state" }, "/home/test"),
      "/state/demur/usage.json",
    );
    assert.strictEqual(
      getCostStatePath({}, "/home/test"),
      "/home/test/.local/state/demur/usage.json",
    );
  });

  it("atomically accumulates concurrent process updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-cost-"));
    const statePath = join(directory, "usage.json");
    const script = [
      `const { recordInputCost } = await import(${JSON.stringify(trackerUrl)});`,
      `await recordInputCost(125, ${JSON.stringify(statePath)});`,
    ].join("\n");

    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          execFilePromise(
            "node",
            [
              "--experimental-strip-types",
              "--input-type=module",
              "--eval",
              script,
            ],
          ),
        ),
      );

      const totals = JSON.parse(await readFile(statePath, "utf8")) as CostTotals;
      assert.strictEqual(totals.version, 1);
      assert.strictEqual(totals.totalInputTokens, 1_000);
      assert.strictEqual(
        totals.estimatedCostUsd,
        estimateInputCostUsd(1_000),
      );
      assert.match(totals.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed state instead of overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demur-cost-"));
    const statePath = join(directory, "usage.json");

    try {
      await writeFile(statePath, "not-json\n");
      let failure: unknown;
      try {
        await recordInputCost(10, statePath);
      } catch (error: unknown) {
        failure = error;
      }
      assert.instanceOf(failure, Error);
      assert.strictEqual(await readFile(statePath, "utf8"), "not-json\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
