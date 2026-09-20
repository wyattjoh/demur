import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, it } from "@effect/vitest";
import type { Verdict } from "../../src/types.ts";
import { estimateInputCostUsd } from "./cost-tracker.ts";
import {
  getDemurConfigPath,
  loadDemurSettings,
  saveDemurSettings,
} from "./settings.ts";
import demur, {
  formatEvaluationDuration,
  formatRunNotification,
  handleToolCall,
  resolveVerdict,
} from "./index.ts";

const execFilePromise = promisify(execFile);
const extensionUrl = new URL("./index.ts", import.meta.url).href;

describe("Pi extension", () => {
  it("registers the demur settings command", () => {
    let registeredCommand: string | undefined;
    demur({
      registerCommand: (name: string) => {
        registeredCommand = name;
      },
      on: () => {},
    } as unknown as ExtensionAPI);

    assert.strictEqual(registeredCommand, "demur");
  });

  it("persists menu changes and updates the bottom-bar status", async () => {
    let commandHandler:
      | ((args: string, ctx: ExtensionContext) => Promise<void>)
      | undefined;
    let sessionStartHandler:
      | ((event: unknown, ctx: ExtensionContext) => Promise<void>)
      | undefined;
    demur({
      registerCommand: (
        _name: string,
        options: {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        },
      ) => {
        commandHandler = options.handler;
      },
      on: (event: string, handler: unknown) => {
        if (event === "session_start") {
          sessionStartHandler = handler as typeof sessionStartHandler;
        }
      },
    } as unknown as ExtensionAPI);

    const configDirectory = await mkdtemp(join(tmpdir(), "demur-menu-"));
    const previousConfigDirectory = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDirectory;
    const statuses: string[] = [];
    const selections = ["Disable demur"];
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      signal: undefined,
      ui: {
        notify: () => {},
        select: async () => selections.shift(),
        setStatus: (_key: string, value: string | undefined) => {
          if (value !== undefined) statuses.push(value);
        },
        theme: {
          fg: (_color: string, value: string) => value,
        },
      },
    } as unknown as ExtensionContext;

    try {
      if (sessionStartHandler === undefined || commandHandler === undefined) {
        assert.fail("demur did not register its session and command handlers");
      }

      await sessionStartHandler({}, ctx);
      assert.strictEqual(statuses.at(-1), "demur: enabled");

      const configPath = getDemurConfigPath(
        { XDG_CONFIG_HOME: configDirectory },
        "/unused",
      );
      await saveDemurSettings(
        { enabled: true, failurePolicy: "ask" },
        configPath,
      );

      await commandHandler("", ctx);
      assert.strictEqual(statuses.at(-1), "demur: disabled");
      assert.deepEqual(
        await loadDemurSettings(configPath),
        { enabled: false, failurePolicy: "ask" },
      );
    } finally {
      if (previousConfigDirectory === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigDirectory;
      }
    }
  });

  it("reloads global settings before every tool invocation", async () => {
    let sessionStartHandler:
      | ((event: unknown, ctx: ExtensionContext) => Promise<void>)
      | undefined;
    let toolCallHandler:
      | ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>)
      | undefined;
    demur({
      registerCommand: () => {},
      on: (event: string, handler: unknown) => {
        if (event === "session_start") {
          sessionStartHandler = handler as typeof sessionStartHandler;
        }
        if (event === "tool_call") {
          toolCallHandler = handler as typeof toolCallHandler;
        }
      },
    } as unknown as ExtensionAPI);

    const configDirectory = await mkdtemp(join(tmpdir(), "demur-refresh-"));
    const previousConfigDirectory = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDirectory;
    const statuses: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      signal: undefined,
      ui: {
        notify: () => {},
        setStatus: (_key: string, value: string | undefined) => {
          if (value !== undefined) statuses.push(value);
        },
        theme: {
          fg: (_color: string, value: string) => value,
        },
      },
    } as unknown as ExtensionContext;

    try {
      if (sessionStartHandler === undefined || toolCallHandler === undefined) {
        assert.fail("demur did not register its session and tool handlers");
      }

      await sessionStartHandler({}, ctx);
      assert.strictEqual(statuses.at(-1), "demur: enabled");

      await saveDemurSettings(
        { enabled: false, failurePolicy: "ask" },
        getDemurConfigPath({ XDG_CONFIG_HOME: configDirectory }, "/unused"),
      );
      await toolCallHandler(
        {
          toolName: "read",
          toolCallId: "refresh-test",
          input: { path: "README.md" },
        } as unknown as ToolCallEvent,
        ctx,
      );

      assert.strictEqual(statuses.at(-1), "demur: disabled");
    } finally {
      if (previousConfigDirectory === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigDirectory;
      }
    }
  });

  it("bypasses the guard worker while demur is disabled", async () => {
    const context = createContext(true, true);
    const event = {
      toolName: "bash",
      toolCallId: "disabled-test",
      input: { command: "printf ok" },
    } as ToolCallEvent;

    assert.strictEqual(
      await handleToolCall(event, context.ctx, {
        enabled: false,
        failurePolicy: "block",
      }),
      undefined,
    );
  });

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

  it("applies the configured policy only to guard failures", async () => {
    const failureVerdict: Verdict = {
      decision: "deny",
      reason: "demur: guard unavailable (timeout) — timed out Blocking because demur fails closed. Set DEMUR_DISABLE=1 to bypass.",
      judgments: undefined,
      failure: "timeout",
      latencyMs: 4_000,
      usage: undefined,
    };
    const deniedVerdict: Verdict = {
      ...failureVerdict,
      reason: "demur: destructive command",
      failure: undefined,
    };
    const allowContext = createContext(true, true);

    assert.strictEqual(
      await resolveVerdict(
        failureVerdict,
        "dangerous command",
        allowContext.ctx,
        "allow",
        undefined,
        4_000,
      ),
      undefined,
    );
    assert.deepEqual(
      await resolveVerdict(
        deniedVerdict,
        "dangerous command",
        allowContext.ctx,
        "allow",
        undefined,
        4_000,
      ),
      { block: true, reason: "demur: destructive command" },
    );

    const blockContext = createContext(true, true);
    const blocked = await resolveVerdict(
      failureVerdict,
      "dangerous command",
      blockContext.ctx,
      "block",
      undefined,
      4_000,
    );
    assert.strictEqual(blocked?.block, true);
    assert.include(blocked?.reason, "Pi failure policy is block");
    assert.notInclude(blocked?.reason, "DEMUR_DISABLE");

    const askContext = createContext(true, true);
    assert.strictEqual(
      await resolveVerdict(
        failureVerdict,
        "dangerous command",
        askContext.ctx,
        "ask",
        undefined,
        4_000,
      ),
      undefined,
    );
    assert.strictEqual(askContext.confirmations.length, 1);
  });

  it("blocks an ask failure policy when no interactive UI exists", async () => {
    const context = createContext(false, true);
    const result = await resolveVerdict(
      {
        decision: "deny",
        reason: "demur: guard worker crashed — unavailable",
        judgments: undefined,
        failure: "unexpected",
        latencyMs: 1,
        usage: undefined,
      },
      "command",
      context.ctx,
      "ask",
      undefined,
      1,
    );

    assert.strictEqual(result?.block, true);
    assert.include(result?.reason, "no interactive UI");
    assert.strictEqual(context.confirmations.length, 0);
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

function createContext(hasUI: boolean, approved: boolean): {
  ctx: ExtensionContext;
  confirmations: string[];
} {
  const confirmations: string[] = [];
  return {
    ctx: {
      cwd: process.cwd(),
      hasUI,
      signal: undefined,
      ui: {
        confirm: async (_title: string, message: string) => {
          confirmations.push(message);
          return approved;
        },
        notify: () => {},
      },
    } as unknown as ExtensionContext,
    confirmations,
  };
}
