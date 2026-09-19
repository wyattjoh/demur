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
 * @returns A block result when the command is denied, otherwise nothing
 */
export async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
  if (!isToolCallEventType("bash", event)) return undefined;

  const command = event.input.command ?? "";
  if (command.trim() === "") return undefined;

  const evaluationStartedAt = performance.now();
  let verdict: Verdict;
  try {
    verdict = await runGuardWorker(command, ctx.cwd, ctx.signal);
  } catch (error: unknown) {
    const evaluationMs = performance.now() - evaluationStartedAt;
    notifyRun(ctx, "ERROR", undefined, undefined, evaluationMs, "warning");
    return {
      block: true,
      reason: `demur: guard worker crashed — ${errorDetail(error)} Blocking because demur fails closed. Set DEMUR_DISABLE=1 to bypass.`,
    };
  }

  const evaluationMs = performance.now() - evaluationStartedAt;
  const inputTokens = verdict.usage?.inputTokens;
  const accumulatedCostUsd = await recordAccumulatedCost(inputTokens);

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
  pi.on("tool_call", handleToolCall);
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

  const { decision, reason } = value as Record<string, unknown>;
  if (
    (decision !== "allow" && decision !== "ask" && decision !== "deny") ||
    typeof reason !== "string"
  ) {
    throw new Error("verdict must contain a valid decision and reason");
  }

  return value as Verdict;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
