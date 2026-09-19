import { assert, describe, it } from "@effect/vitest";
import { runCli, type CliDependencies } from "./cli.ts";
import type { ResolvedApiKey } from "./key.ts";
import type { Verdict } from "./types.ts";

const allowedVerdict: Verdict = {
  decision: "allow",
  reason: "demur: safe",
  judgments: undefined,
  failure: undefined,
  latencyMs: 12,
  usage: undefined,
};

type CliState = {
  resolved: ResolvedApiKey | undefined;
  stored: string | undefined;
  deleted: boolean;
  promptCalls: number;
  judged: { command: string; cwd: string } | undefined;
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
    resolveApiKey: async () => state.resolved,
    storeApiKey: async (value) => {
      state.stored = value;
    },
    deleteApiKey: async () => state.deleted,
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
