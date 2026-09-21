import {
  Cause,
  Clock,
  Effect,
  Exit,
  Predicate,
  Result,
} from "effect";
import { judgeEffect, Judgment, TYPESAFE_MODEL } from "./judge.ts";
import { Environment } from "./key.ts";
import {
  applyStaticGate,
  decide,
  POLICY_VERSION,
  THRESHOLDS,
} from "./policy.ts";
import { QUESTION_SET_VERSION } from "./questions.ts";
import { gatherStateEffect, GitCommand, renderState } from "./state.ts";
import type {
  CommandState,
  GuardEvaluation,
  Host,
  Verdict,
} from "./types.ts";

const PREFIX = "demur:";

/**
 * Effect-native guard implementation with replayable evidence.
 *
 * @param command - The shell command the agent wants to run
 * @param cwd - Absolute working directory for the command
 * @param agent - Which coding agent is asking
 * @returns A fail-closed verdict and the exact evidence behind it
 */
export const guardEvaluationEffect = Effect.fn("guardEvaluationEffect")(
  function* (
    command: string,
    cwd: string,
    agent: Host,
  ): Effect.fn.Return<
    GuardEvaluation,
    never,
    Environment | GitCommand | Judgment
  > {
    const started = yield* Clock.monotonicTimeNanos;
    const core = Effect.gen(function* () {
      const environment = yield* Environment;
      const disabled = isDisabled(yield* environment.get("DEMUR_DISABLE"));

      if (disabled) {
        const verdict = yield* completeVerdict(started, {
          ...emptyEvidence,
          decision: "allow",
          reason: `${PREFIX} disabled via DEMUR_DISABLE.`,
        });
        return { verdict, evidence: undefined } satisfies GuardEvaluation;
      }

      if (command.trim() === "") {
        const verdict = yield* completeVerdict(started, {
          ...emptyEvidence,
          decision: "allow",
          reason: `${PREFIX} empty command.`,
        });
        return { verdict, evidence: undefined } satisfies GuardEvaluation;
      }

      const state = yield* gatherStateEffect(command, cwd, agent);
      const verdict = yield* judgeStateCore(state, started, 0);
      return {
        verdict,
        evidence: {
          modelState: renderState(state),
          analysis: state.analysis,
          model: TYPESAFE_MODEL,
          questionSetVersion: QUESTION_SET_VERSION,
          policyVersion: POLICY_VERSION,
          policyThresholds: { ...THRESHOLDS },
        },
      } satisfies GuardEvaluation;
    });

    const exit = yield* Effect.exit(core);
    if (Exit.isSuccess(exit)) return exit.value;

    return {
      verdict: yield* unexpectedVerdict(started, exit.cause, 0),
      evidence: undefined,
    };
  },
);

/**
 * Effect-native guard implementation used by the Promise boundary.
 *
 * @param command - The shell command the agent wants to run
 * @param cwd - Absolute working directory for the command
 * @param agent - Which coding agent is asking
 * @returns A fail-closed verdict
 */
export const guardEffect = Effect.fn("guardEffect")(function* (
  command: string,
  cwd: string,
  agent: Host,
): Effect.fn.Return<Verdict, never, Environment | GitCommand | Judgment> {
  const evaluation = yield* guardEvaluationEffect(command, cwd, agent);
  return evaluation.verdict;
});

/**
 * Effect-native judgment for state that has already been collected.
 *
 * @param state - Pre-collected command state
 * @param latencyOffsetMs - Time already spent before entering this Effect
 * @returns A fail-closed verdict
 */
export const judgeStateEffect = Effect.fn("judgeStateEffect")(function* (
  state: CommandState,
  latencyOffsetMs = 0,
): Effect.fn.Return<Verdict, never, Judgment> {
  const started = yield* Clock.monotonicTimeNanos;
  const exit = yield* Effect.exit(
    judgeStateCore(state, started, latencyOffsetMs),
  );
  if (Exit.isSuccess(exit)) return exit.value;

  return yield* unexpectedVerdict(started, exit.cause, latencyOffsetMs);
});

const judgeStateCore = Effect.fn("judgeStateCore")(function* (
  state: CommandState,
  started: bigint,
  latencyOffsetMs: number,
): Effect.fn.Return<Verdict, never, Judgment> {
  const result = yield* Effect.result(judgeEffect(state));

  if (Result.isFailure(result)) {
    return yield* completeVerdict(
      started,
      {
        ...emptyEvidence,
        decision: "deny",
        reason: `${PREFIX} guard unavailable (${result.failure.failure}) — ${result.failure.detail} Blocking because demur fails closed. Set DEMUR_DISABLE=1 to bypass.`,
        failure: result.failure.failure,
      },
      latencyOffsetMs,
    );
  }

  const success = result.success;
  const outcome = applyStaticGate(
    decide(success.judgments),
    state.analysis,
    success.judgments,
  );

  return yield* completeVerdict(
    started,
    {
      decision: outcome.decision,
      reason: `${PREFIX} ${outcome.reason}`,
      judgments: success.judgments,
      failure: undefined,
      usage: success.usage,
    },
    latencyOffsetMs,
  );
});

const emptyEvidence = {
  judgments: undefined,
  failure: undefined,
  usage: undefined,
} as const;

type VerdictWithoutLatency = Omit<Verdict, "latencyMs">;

function completeVerdict(
  started: bigint,
  verdict: VerdictWithoutLatency,
  latencyOffsetMs = 0,
): Effect.Effect<Verdict> {
  return Effect.map(Clock.monotonicTimeNanos, (finished) => ({
    ...verdict,
    latencyMs:
      latencyOffsetMs + Number((finished - started) / BigInt(1_000_000)),
  }));
}

function unexpectedVerdict(
  started: bigint,
  cause: Cause.Cause<unknown>,
  latencyOffsetMs: number,
): Effect.Effect<Verdict> {
  const error = Cause.squash(cause);
  const detail = Predicate.isError(error) ? error.message : String(error);

  return completeVerdict(
    started,
    {
      ...emptyEvidence,
      decision: "deny",
      reason: `${PREFIX} guard crashed — ${detail} Blocking because demur fails closed. Set DEMUR_DISABLE=1 to bypass.`,
      failure: "unexpected",
    },
    latencyOffsetMs,
  );
}

function isDisabled(flag: string | undefined): boolean {
  const normalized = flag?.trim();
  return normalized === "1" || normalized === "true";
}
