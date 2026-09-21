import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Verdict } from "../../src/types.ts";
import {
  estimateInputCostUsd,
  recordInputCost,
} from "./cost-tracker.ts";
import {
  DEFAULT_DEMUR_SETTINGS,
  DEMUR_MODES,
  FAILURE_POLICIES,
  loadDemurSettings,
  parseDemurMode,
  parseFailurePolicy,
  saveDemurSettings,
  type DemurSettings,
  type FailurePolicy,
} from "./settings.ts";
import { recordTrainingEvaluation } from "./training-store.ts";

const WORKER_PATH = fileURLToPath(
  new URL("../../src/adapters/pi-worker.ts", import.meta.url),
);
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024;

/**
 * Handle one `tool_call` event, guarding shell commands only.
 *
 * Exported separately from the extension factory so it can be exercised
 * directly in tests without standing up a Pi runtime.
 *
 * @param event - The tool call Pi is about to execute
 * @param ctx - Extension context, used for the working directory and prompts
 * @param settings - Current global Pi extension settings
 * @returns A block result when the command is denied, otherwise nothing
 */
export async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  settings: DemurSettings = DEFAULT_DEMUR_SETTINGS,
): Promise<ToolCallEventResult | undefined> {
  if (!isToolCallEventType("bash", event)) return undefined;
  if (settings.mode === "disabled") return undefined;

  const command = event.input.command ?? "";
  if (command.trim() === "") return undefined;

  const evaluationStartedAt = performance.now();
  let verdict: Verdict;
  try {
    verdict = await runGuardWorker(command, ctx.cwd, ctx.signal);
  } catch (error: unknown) {
    const evaluationMs = performance.now() - evaluationStartedAt;
    if (ctx.signal?.aborted) {
      notifyRun(
        ctx,
        "CANCELLED → BLOCK",
        undefined,
        undefined,
        evaluationMs,
        "warning",
      );
      return {
        block: true,
        reason: "demur: guard request cancelled, so blocking the command.",
      };
    }

    verdict = {
      decision: "deny",
      reason: `demur: guard worker crashed — ${errorDetail(error)}`,
      judgments: undefined,
      failure: "unexpected",
      latencyMs: evaluationMs,
      usage: undefined,
    };
  }

  const evaluationMs = performance.now() - evaluationStartedAt;
  const inputTokens = verdict.usage?.inputTokens;
  const accumulatedCostUsd = await recordAccumulatedCost(inputTokens);
  const result = settings.mode === "passive"
    ? resolvePassiveVerdict(
      verdict,
      ctx,
      accumulatedCostUsd,
      evaluationMs,
    )
    : await resolveVerdict(
      verdict,
      command,
      ctx,
      settings.failurePolicy,
      accumulatedCostUsd,
      evaluationMs,
    );

  if (settings.training) {
    await recordTrainingResult(
      command,
      ctx,
      settings.mode,
      verdict,
      result,
    );
  }
  return result;
}

/**
 * Apply the Pi extension's host policy to one completed guard verdict.
 *
 * A configured failure policy is consulted only when `verdict.failure` is set.
 * Ordinary model and deterministic-policy denials always remain blocked.
 *
 * @param verdict - Completed demur guard result
 * @param command - Shell command awaiting execution
 * @param ctx - Pi extension context used for prompts and notifications
 * @param failurePolicy - Host action to take when the guard failed
 * @param accumulatedCostUsd - Persisted global estimate after this run
 * @param evaluationMs - Wall-clock time spent obtaining the guard verdict
 * @returns A block result when Pi must stop the command, otherwise nothing
 */
export async function resolveVerdict(
  verdict: Verdict,
  command: string,
  ctx: ExtensionContext,
  failurePolicy: FailurePolicy,
  accumulatedCostUsd: number | undefined,
  evaluationMs: number,
): Promise<ToolCallEventResult | undefined> {
  const inputTokens = verdict.usage?.inputTokens;
  if (verdict.failure !== undefined) {
    return handleGuardFailure(
      stripFailClosedSuffix(verdict.reason),
      command,
      ctx,
      failurePolicy,
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
    );
  }

  if (verdict.decision === "allow") {
    notifyRun(
      ctx,
      "ALLOW",
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
      "info",
    );
    return undefined;
  }

  if (verdict.decision === "deny") {
    notifyRun(
      ctx,
      "DENY",
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
      "warning",
    );
    return { block: true, reason: verdict.reason };
  }

  // "ask": Pi can put the decision in front of the user, which is strictly
  // better than the agent guessing. Without a UI there is nobody to ask, so the
  // fail-closed posture applies and the command is blocked.
  if (!ctx.hasUI) {
    notifyRun(
      ctx,
      "ASK → BLOCK",
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
      "warning",
    );
    return {
      block: true,
      reason: `${verdict.reason} No interactive UI available to confirm, so blocking.`,
    };
  }

  const approved = await ctx.ui.confirm("demur", `${verdict.reason}\n\n${command}\n\nRun it anyway?`);
  notifyRun(
    ctx,
    approved ? "ASK → ALLOW" : "ASK → BLOCK",
    inputTokens,
    accumulatedCostUsd,
    evaluationMs,
    approved ? "info" : "warning",
  );
  if (approved) return undefined;

  return { block: true, reason: `${verdict.reason} Declined by the user.` };
}

/**
 * Report a completed verdict without allowing it to affect execution.
 *
 * Passive mode never prompts and never returns a block result. Failures remain
 * visible as failures rather than being mapped through the enforcement-only
 * failure policy.
 *
 * @param verdict - Completed demur guard result
 * @param ctx - Pi extension context used for notifications
 * @param accumulatedCostUsd - Persisted global estimate after this run
 * @param evaluationMs - Wall-clock time spent obtaining the guard verdict
 * @returns Nothing so Pi continues with the command
 */
export function resolvePassiveVerdict(
  verdict: Verdict,
  ctx: ExtensionContext,
  accumulatedCostUsd: number | undefined,
  evaluationMs: number,
): undefined {
  const source = verdict.failure === undefined
    ? verdict.decision.toUpperCase()
    : "FAILURE";
  const result = `PASSIVE: ${source} · NOT ENFORCED`;
  notifyRun(
    ctx,
    result,
    verdict.usage?.inputTokens,
    accumulatedCostUsd,
    evaluationMs,
    source === "ALLOW" ? "info" : "warning",
  );
  return undefined;
}

/**
 * Format the compact status Pi prints after each demur run.
 *
 * @param result - Guard decision and any final user-confirmation outcome
 * @param inputTokens - Submitted Jev input tokens, when a judgment completed
 * @param accumulatedCostUsd - Persisted global estimate after this run
 * @param evaluationMs - Wall-clock time spent obtaining the guard verdict
 * @returns One-line status with costs and evaluation duration
 */
export function formatRunNotification(
  result: string,
  inputTokens: number | undefined,
  accumulatedCostUsd: number | undefined,
  evaluationMs: number,
): string {
  const duration = `evaluated in ${formatEvaluationDuration(evaluationMs)}`;
  if (inputTokens === undefined) {
    return `demur: ${result} · cost unavailable · ${duration}`;
  }

  const accumulated =
    accumulatedCostUsd === undefined
      ? "accumulated unavailable"
      : `accumulated ${formatUsd(accumulatedCostUsd)}`;
  return `demur: ${result} · ${inputTokens.toLocaleString("en-US")} input tokens · estimated cost ${formatUsd(estimateInputCostUsd(inputTokens))} · ${accumulated} · ${duration}`;
}

/**
 * Format an evaluation duration using compact human-readable units.
 *
 * @param milliseconds - Non-negative wall-clock duration in milliseconds
 * @returns Duration rendered in milliseconds, seconds, or minutes
 */
export function formatEvaluationDuration(milliseconds: number): string {
  const bounded = Math.max(0, milliseconds);
  if (bounded < 1) return "<1 ms";
  if (bounded < 1_000) return `${Math.round(bounded)} ms`;
  if (bounded < 60_000) return `${formatDecimal(bounded / 1_000, bounded < 10_000 ? 2 : 1)} s`;

  const minutes = Math.floor(bounded / 60_000);
  const seconds = (bounded % 60_000) / 1_000;
  return `${minutes}m ${formatDecimal(seconds, seconds < 10 ? 1 : 0)}s`;
}

/**
 * Run the Bun-native guard behind Pi's Node-compatible extension boundary.
 *
 * The API key remains inside the worker process: only the command request and
 * resulting verdict cross the local stdio pipes.
 *
 * @param command - The shell command Pi is about to execute
 * @param cwd - Absolute working directory for the command
 * @param signal - Optional cancellation signal from Pi
 * @param environment - Environment inherited by the Bun worker
 * @returns The guard verdict produced by the worker
 */
export function runGuardWorker(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("guard request cancelled"));
      return;
    }

    const child = spawn("bun", [WORKER_PATH], {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      outcome();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error("guard request cancelled")));
    };
    const appendBounded = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(0, MAX_WORKER_OUTPUT_BYTES);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
      if (stdout.length >= MAX_WORKER_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
      if (stderr.length >= MAX_WORKER_OUTPUT_BYTES) child.kill();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, exitSignal) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim() || `exit ${code ?? exitSignal ?? "unknown"}`;
          reject(new Error(detail));
          return;
        }

        try {
          resolve(parseVerdict(stdout));
        } catch (error: unknown) {
          reject(new Error(`invalid guard worker response: ${errorDetail(error)}`));
        }
      });
    });

    child.stdin.on("error", (error) => finish(() => reject(error)));
    child.stdin.end(JSON.stringify({ command, cwd }));
  });
}

/**
 * Pi extension entry point.
 *
 * Routes every bash tool call through a TypeSafe System One judgment before Pi
 * is allowed to execute it.
 *
 * @param pi - The extension API provided by Pi
 */
export default function demur(pi: ExtensionAPI): void {
  let settings = { ...DEFAULT_DEMUR_SETTINGS };

  pi.registerCommand("demur", {
    description: "Configure the demur guard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("The /demur menu requires an interactive UI.", "warning");
        return;
      }

      await refreshSettings(ctx);
      const modeLabel = `Change mode (current: ${settings.mode})`;
      const trainingLabel = settings.training
        ? "Disable training capture"
        : "Enable training capture";
      const policyLabel = `Change failure policy (current: ${settings.failurePolicy})`;
      const actions = settings.mode === "disabled"
        ? [modeLabel, policyLabel]
        : [modeLabel, trainingLabel, policyLabel];
      const action = await ctx.ui.select("demur", actions);
      if (action === undefined) return;

      if (action === modeLabel) {
        const selection = await ctx.ui.select(
          `demur mode (current: ${settings.mode})`,
          [...DEMUR_MODES],
        );
        if (selection === undefined) return;

        const mode = parseDemurMode(selection);
        if (mode === undefined) return;
        await persistSettings(
          {
            ...settings,
            mode,
            training: mode === "disabled" ? false : settings.training,
          },
          ctx,
        );
        return;
      }

      if (action === trainingLabel) {
        await persistSettings(
          { ...settings, training: !settings.training },
          ctx,
        );
        return;
      }

      const selection = await ctx.ui.select(
        `demur failure policy (current: ${settings.failurePolicy})`,
        [...FAILURE_POLICIES],
      );
      if (selection === undefined) return;

      const failurePolicy = parseFailurePolicy(selection);
      if (failurePolicy === undefined) return;
      await persistSettings({ ...settings, failurePolicy }, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshSettings(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    await refreshSettings(ctx);
    return handleToolCall(event, ctx, settings);
  });

  async function refreshSettings(ctx: ExtensionContext): Promise<void> {
    try {
      settings = await loadDemurSettings();
    } catch (error: unknown) {
      settings = { ...DEFAULT_DEMUR_SETTINGS };
      ctx.ui.notify(
        `Could not load demur settings; using enforce/block with training off: ${errorDetail(error)}`,
        "warning",
      );
    }
    updateStatus(ctx, settings);
  }

  async function persistSettings(
    nextSettings: DemurSettings,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      await saveDemurSettings(nextSettings);
      settings = nextSettings;
      updateStatus(ctx, settings);
      ctx.ui.notify(settingsNotification(settings), "info");
    } catch (error: unknown) {
      ctx.ui.notify(
        `Could not save demur settings: ${errorDetail(error)}`,
        "error",
      );
    }
  }
}

function updateStatus(
  ctx: ExtensionContext,
  settings: DemurSettings,
): void {
  const training = settings.training ? " + training" : "";
  const color = settings.mode === "enforce" && !settings.training
    ? "success"
    : "warning";
  ctx.ui.setStatus(
    "demur",
    ctx.ui.theme.fg(color, `demur: ${settings.mode}${training}`),
  );
}

function settingsNotification(settings: DemurSettings): string {
  const training = settings.training ? "on" : "off";
  return `demur mode: ${settings.mode}; training: ${training}; failure policy: ${settings.failurePolicy}.`;
}

async function recordTrainingResult(
  command: string,
  ctx: ExtensionContext,
  mode: "enforce" | "passive",
  verdict: Verdict,
  result: ToolCallEventResult | undefined,
): Promise<void> {
  try {
    await recordTrainingEvaluation({
      command,
      cwd: ctx.cwd,
      mode,
      verdict,
      hostAction: result?.block === true ? "block" : "allow",
    });
  } catch (error: unknown) {
    ctx.ui.notify(
      `demur: could not record training evaluation — ${errorDetail(error)}`,
      "warning",
    );
  }
}

async function handleGuardFailure(
  reason: string,
  command: string,
  ctx: ExtensionContext,
  failurePolicy: FailurePolicy,
  inputTokens: number | undefined,
  accumulatedCostUsd: number | undefined,
  evaluationMs: number,
): Promise<ToolCallEventResult | undefined> {
  if (failurePolicy === "allow") {
    notifyRun(
      ctx,
      "FAILURE → ALLOW",
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
      "warning",
    );
    return undefined;
  }

  if (failurePolicy === "block") {
    notifyRun(
      ctx,
      "FAILURE → BLOCK",
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
      "warning",
    );
    return {
      block: true,
      reason: `${reason} Blocking because the Pi failure policy is block.`,
    };
  }

  if (!ctx.hasUI) {
    notifyRun(
      ctx,
      "FAILURE → BLOCK",
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
      "warning",
    );
    return {
      block: true,
      reason: `${reason} The Pi failure policy is ask, but no interactive UI is available, so blocking.`,
    };
  }

  const approved = await ctx.ui.confirm(
    "demur guard failure",
    `${reason}\n\n${command}\n\nThe guard could not validate this command. Run it anyway?`,
  );
  notifyRun(
    ctx,
    approved ? "FAILURE → ALLOW" : "FAILURE → BLOCK",
    inputTokens,
    accumulatedCostUsd,
    evaluationMs,
    "warning",
  );
  if (approved) return undefined;

  return {
    block: true,
    reason: `${reason} Execution declined after the guard failure.`,
  };
}

function stripFailClosedSuffix(reason: string): string {
  return reason.replace(
    / Blocking because demur fails closed\. Set DEMUR_DISABLE=1 to bypass\.$/,
    "",
  );
}

function notifyRun(
  ctx: ExtensionContext,
  result: string,
  inputTokens: number | undefined,
  accumulatedCostUsd: number | undefined,
  evaluationMs: number,
  level: "info" | "warning",
): void {
  ctx.ui.notify(
    formatRunNotification(
      result,
      inputTokens,
      accumulatedCostUsd,
      evaluationMs,
    ),
    level,
  );
}

async function recordAccumulatedCost(
  inputTokens: number | undefined,
): Promise<number | undefined> {
  if (inputTokens === undefined) return undefined;

  try {
    return (await recordInputCost(inputTokens)).estimatedCostUsd;
  } catch {
    return undefined;
  }
}

function formatDecimal(value: number, fractionDigits: number): string {
  return value
    .toFixed(fractionDigits)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

function formatUsd(value: number): string {
  const decimal = value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return `$${decimal}`;
}

function parseVerdict(output: string): Verdict {
  const value: unknown = JSON.parse(output);
  if (value === null || typeof value !== "object") {
    throw new Error("verdict must be an object");
  }

  const { decision, reason, judgments, failure, latencyMs, usage } =
    value as Record<string, unknown>;
  if (
    (decision !== "allow" && decision !== "ask" && decision !== "deny") ||
    typeof reason !== "string" ||
    typeof latencyMs !== "number" ||
    !Number.isFinite(latencyMs)
  ) {
    throw new Error("verdict must contain a valid decision, reason, and latency");
  }

  return {
    decision,
    reason,
    judgments: judgments as Verdict["judgments"],
    failure: failure as Verdict["failure"],
    latencyMs,
    usage: usage as Verdict["usage"],
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
