import { Layer, ManagedRuntime, Predicate } from "effect";
import {
  guardEffect,
  guardEvaluationEffect,
  judgeStateEffect,
} from "./guard.internal.ts";
import { Judgment } from "./judge.ts";
import { Environment } from "./key.ts";
import { GitCommand } from "./state.ts";
import type {
  CommandState,
  GuardEvaluation,
  Host,
  Verdict,
} from "./types.ts";

const PREFIX = "demur:";

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Environment.layer, GitCommand.layer, Judgment.layer),
);

/**
 * Judge one command and decide what the host should do with it.
 *
 * Fails closed: any path that does not produce a judgment returns `deny`, with
 * a reason that names the failure so an outage is never mistaken for a policy
 * decision. This Promise is the compatibility boundary around the Effect
 * implementation.
 *
 * @param command - The shell command the agent wants to run
 * @param cwd - Absolute working directory for the command
 * @param agent - Which coding agent is asking
 * @param signal - Optional cancellation signal from the host
 * @returns The verdict, including the judgments behind it
 */
export function guard(
  command: string,
  cwd: string,
  agent: Host,
  signal: AbortSignal | undefined = undefined,
): Promise<Verdict> {
  const started = performance.now();

  return runtime
    .runPromise(
      guardEffect(command, cwd, agent),
      signal === undefined ? undefined : { signal },
    )
    .catch((error: unknown) => unexpectedVerdict(error, started));
}

/**
 * Judge one command while retaining the exact state and policy versions.
 *
 * This boundary is used only when a host has enabled local training capture;
 * ordinary guard callers continue to receive the smaller {@link Verdict}.
 *
 * @param command - The shell command the agent wants to run
 * @param cwd - Absolute working directory for the command
 * @param agent - Which coding agent is asking
 * @param signal - Optional cancellation signal from the host
 * @returns The verdict and replayable evidence, when state collection occurred
 */
export function guardWithEvidence(
  command: string,
  cwd: string,
  agent: Host,
  signal: AbortSignal | undefined = undefined,
): Promise<GuardEvaluation> {
  const started = performance.now();

  return runtime
    .runPromise(
      guardEvaluationEffect(command, cwd, agent),
      signal === undefined ? undefined : { signal },
    )
    .catch((error: unknown) => ({
      verdict: unexpectedVerdict(error, started),
      evidence: undefined,
    }));
}

/**
 * Judge a command from state that has already been collected.
 *
 * Separate from {@link guard} so the eval harness can hold context fixed across
 * a corpus run instead of picking up whatever repository it happens to run in.
 *
 * @param state - Pre-collected command state
 * @param signal - Optional cancellation signal from the host
 * @param startedAt - `performance.now()` reading to measure latency from
 * @returns The verdict, including the judgments behind it
 */
export function judgeState(
  state: CommandState,
  signal: AbortSignal | undefined = undefined,
  startedAt: number | undefined = undefined,
): Promise<Verdict> {
  const enteredAt = performance.now();
  const latencyOffsetMs =
    startedAt === undefined ? 0 : Math.max(0, Math.round(enteredAt - startedAt));

  return runtime
    .runPromise(
      judgeStateEffect(state, latencyOffsetMs),
      signal === undefined ? undefined : { signal },
    )
    .catch((error: unknown) =>
      unexpectedVerdict(error, startedAt ?? enteredAt),
    );
}

function unexpectedVerdict(error: unknown, startedAt: number): Verdict {
  const detail = Predicate.isError(error) ? error.message : String(error);
  return {
    decision: "deny",
    reason: `${PREFIX} guard crashed — ${detail} Blocking because demur fails closed. Set DEMUR_DISABLE=1 to bypass.`,
    judgments: undefined,
    failure: "unexpected",
    usage: undefined,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}
