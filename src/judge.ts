import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import {
  Cause,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { AiError, DecisionModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  Environment,
  MISSING_KEY_HELP,
  TypeSafeApiKey,
} from "./key.ts";
import { COMMAND_JUDGMENTS } from "./questions.ts";
import { renderState } from "./state.ts";
import type { CommandState, FailureKind, Judgments } from "./types.ts";

/**
 * Default per-attempt timeout for the judgment call.
 *
 * Override with `DEMUR_TIMEOUT_MS`. This sits in front of every Bash call the
 * agent makes, so it is a latency budget, not a generosity setting.
 */
const DEFAULT_TIMEOUT_MS = 4000;

const TYPESAFE_MODEL = "jev-latest";

/**
 * Build the TypeSafe-backed Effect decision model for one API key.
 *
 * @param apiKey - TypeSafe API key to redact and attach to requests
 * @returns A complete decision-model layer with its HTTP dependency provided
 */
export function makeDecisionModelLayer(apiKey: string) {
  return TypeSafeDecisionModel.layer({ model: TYPESAFE_MODEL }).pipe(
    Layer.provide(TypeSafeClient.layer({ apiKey: Redacted.make(apiKey) })),
    Layer.provide(FetchHttpClient.layer),
  );
}

/**
 * A completed judgment, with the token cost of producing it.
 */
export type JudgeSuccess = {
  ok: true;
  judgments: Judgments;
  usage: { inputTokens: number; outputTokens: number };
};

/**
 * A judgment that could not be produced, and why.
 */
export type JudgeFailure = {
  ok: false;
  failure: FailureKind;
  detail: string;
};

/**
 * The outcome of asking the model about a command.
 */
export type JudgeResult = JudgeSuccess | JudgeFailure;

/**
 * Typed failure raised while obtaining a System One judgment.
 */
export class JudgmentError extends Schema.TaggedError<JudgmentError>()(
  "JudgmentError",
  {
    failure: Schema.Literals([
      "no-api-key",
      "credential-error",
      "timeout",
      "api-error",
      "unexpected",
    ]),
    detail: Schema.String,
  },
) {}

/**
 * Effect service that obtains raw judgments for command state.
 */
export class Judgment extends Context.Service<
  Judgment,
  {
    judge(state: CommandState): Effect.Effect<JudgeSuccess, JudgmentError>;
  }
>()("demur/judge/Judgment") {
  static readonly layerNoDeps = Layer.effect(
    Judgment,
    Effect.gen(function* () {
      const environment = yield* Environment;
      const apiKey = yield* TypeSafeApiKey;
      let decisionLayer: ReturnType<typeof makeDecisionModelLayer> | undefined;
      let timeoutMs = DEFAULT_TIMEOUT_MS;

      const getDecisionLayer = Effect.fn("Judgment.getDecisionLayer")(
        function* (): Effect.fn.Return<
          ReturnType<typeof makeDecisionModelLayer>,
          JudgmentError
        > {
          if (decisionLayer !== undefined) return decisionLayer;

          const resolvedApiKey = yield* apiKey.resolve.pipe(
            Effect.mapError(
              (error) =>
                new JudgmentError({
                  failure: "credential-error",
                  detail: `Unable to read the operating system credential store: ${error.detail}`,
                }),
            ),
          );
          if (resolvedApiKey === undefined) {
            return yield* new JudgmentError({
              failure: "no-api-key",
              detail: MISSING_KEY_HELP,
            });
          }

          const configuredTimeout = Number(
            yield* environment.get("DEMUR_TIMEOUT_MS"),
          );
          timeoutMs = configuredTimeout || DEFAULT_TIMEOUT_MS;
          decisionLayer = makeDecisionModelLayer(resolvedApiKey.value);
          return decisionLayer;
        },
      );

      const judge = Effect.fn("Judgment.judge")(function* (
        state: CommandState,
      ): Effect.fn.Return<JudgeSuccess, JudgmentError> {
        const activeDecisionLayer = yield* getDecisionLayer();
        const result = yield* DecisionModel.decide(COMMAND_JUDGMENTS, {
          input: renderState(state),
        }).pipe(
          Effect.provide(activeDecisionLayer),
          Effect.timeout(timeoutMs),
          // One retry only. A guard that retries three times with backoff is a
          // guard that hangs the agent for ten seconds on a bad network.
          Effect.retry({ times: 1, while: isRetryableDecisionError }),
          Effect.mapError(toJudgmentError),
        );
        const answers = result.answers;

        return {
          ok: true,
          judgments: {
            executesDestruction: answers.executesDestruction.probability,
            exposesSensitiveData: answers.exposesSensitiveData.probability,
            weakensSecurityBoundary:
              answers.weakensSecurityBoundary.probability,
            unrecoverable: answers.unrecoverable.probability,
            targetsSharedInfrastructure:
              answers.targetsSharedInfrastructure.probability,
            blastRadius: answers.blastRadius.rating,
            blastRadiusConfidence: answers.blastRadius.confidence ?? 0,
          },
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          },
        };
      });

      return Judgment.of({ judge });
    }),
  );

  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Layer.merge(Environment.layer, TypeSafeApiKey.layer)),
  );
}

/**
 * Ask the configured judgment service about one command.
 *
 * @param state - The command and its surrounding context
 * @returns The judgments, or a typed failure in the Effect error channel
 */
export const judgeEffect = Effect.fn("judgeEffect")(function* (
  state: CommandState,
): Effect.fn.Return<JudgeSuccess, JudgmentError, Judgment> {
  const judgment = yield* Judgment;
  return yield* judgment.judge(state);
});

const runtime = ManagedRuntime.make(Judgment.layer);

/**
 * Ask System One every question about one command, in a single call.
 *
 * This Promise API is retained for existing callers; the implementation runs
 * the Effect-native judgment service through a managed runtime.
 *
 * @param state - The command and its surrounding context
 * @param signal - Optional cancellation signal from the host
 * @returns The judgments, or a typed failure for the caller to act on
 */
export function judge(
  state: CommandState,
  signal: AbortSignal | undefined = undefined,
): Promise<JudgeResult> {
  const program = Effect.gen(function* () {
    const result = yield* Effect.result(judgeEffect(state));
    if (Result.isFailure(result)) {
      return {
        ok: false,
        failure: result.failure.failure,
        detail: result.failure.detail,
      } satisfies JudgeFailure;
    }
    return result.success;
  });

  return runtime
    .runPromise(program, signal === undefined ? undefined : { signal })
    .catch((error: unknown) => ({
      ok: false,
      failure: "unexpected",
      detail: errorDetail(error),
    }));
}

function isRetryableDecisionError(
  error: AiError.AiError | Cause.TimeoutError,
): boolean {
  return Cause.isTimeoutError(error) || error.isRetryable;
}

function toJudgmentError(error: unknown): JudgmentError {
  const failure: FailureKind = Cause.isTimeoutError(error)
    ? "timeout"
    : AiError.isAiError(error)
      ? "api-error"
      : "unexpected";

  return new JudgmentError({ failure, detail: errorDetail(error) });
}

function errorDetail(error: unknown): string {
  return Predicate.isError(error) ? error.message : String(error);
}
