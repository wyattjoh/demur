import { Context, Effect, Layer } from "effect";

/**
 * Effect service for reading process environment variables.
 *
 * Keeping environment access behind a service lets guard tests supply a
 * complete, deterministic process context without mutating global state.
 */
export class Environment extends Context.Service<
  Environment,
  {
    get(name: string): Effect.Effect<string | undefined>;
  }
>()("demur/key/Environment") {
  static readonly layer = Layer.succeed(
    Environment,
    Environment.of({
      get: Effect.fn("Environment.get")(function* (name: string) {
        return Bun.env[name];
      }),
    }),
  );
}

/**
 * Resolve the TypeSafe API key from the environment.
 *
 * demur does not fetch or persist credentials. Export `TYPESAFE_API_KEY` before
 * launching the host agent, or inject it with a secret manager so every hook
 * invocation inherits the already-resolved value.
 *
 * @returns The API key, or `undefined` when the environment does not carry one
 */
export function resolveApiKey(): string | undefined {
  return Bun.env.TYPESAFE_API_KEY?.trim() || undefined;
}

/**
 * What to tell the user when the key is missing.
 *
 * demur fails closed, so a missing key blocks every command. The message has to
 * name the fix, or the failure reads like a policy decision.
 */
export const MISSING_KEY_HELP =
  "No TYPESAFE_API_KEY in the environment. Export it, or inject it with a secret manager, before launching the agent.";
