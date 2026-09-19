import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Predicate,
  Schema,
} from "effect";

const TYPESAFE_SECRET = {
  service: "com.github.wyattjoh.demur",
  name: "typesafe-api-key",
} as const;

/**
 * Where demur found the active TypeSafe API key.
 */
export type ApiKeySource = "environment" | "system";

/**
 * A resolved TypeSafe API key and the source that supplied it.
 */
export type ResolvedApiKey = {
  value: string;
  source: ApiKeySource;
};

/**
 * A failure while accessing the operating system credential store.
 */
export class SecretStoreError extends Schema.TaggedError<SecretStoreError>()(
  "SecretStoreError",
  {
    operation: Schema.Literals(["read", "write", "delete"]),
    detail: Schema.String,
  },
) {}

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
 * Effect service for the operating system's credential storage.
 */
export class SystemSecrets extends Context.Service<
  SystemSecrets,
  {
    get(service: string, name: string): Effect.Effect<string | undefined, SecretStoreError>;
    set(service: string, name: string, value: string): Effect.Effect<void, SecretStoreError>;
    delete(service: string, name: string): Effect.Effect<boolean, SecretStoreError>;
  }
>()("demur/key/SystemSecrets") {
  static readonly layer = Layer.succeed(
    SystemSecrets,
    SystemSecrets.of({
      get: Effect.fn("SystemSecrets.get")(function* (
        service: string,
        name: string,
      ) {
        const value = yield* Effect.tryPromise({
          try: () => Bun.secrets.get({ service, name }),
          catch: secretStoreFailure("read"),
        });
        return value ?? undefined;
      }),
      set: Effect.fn("SystemSecrets.set")(function* (
        service: string,
        name: string,
        value: string,
      ) {
        yield* Effect.tryPromise({
          try: () => Bun.secrets.set({ service, name, value }),
          catch: secretStoreFailure("write"),
        });
      }),
      delete: Effect.fn("SystemSecrets.delete")(function* (
        service: string,
        name: string,
      ) {
        return yield* Effect.tryPromise({
          try: () => Bun.secrets.delete({ service, name }),
          catch: secretStoreFailure("delete"),
        });
      }),
    }),
  );
}

/**
 * Effect service that resolves and manages demur's TypeSafe API key.
 *
 * `TYPESAFE_API_KEY` remains the highest-priority source for automation and
 * one-off overrides. Otherwise, demur reads the key from the operating system's
 * credential store through {@link SystemSecrets}.
 */
export class TypeSafeApiKey extends Context.Service<
  TypeSafeApiKey,
  {
    readonly resolve: Effect.Effect<ResolvedApiKey | undefined, SecretStoreError>;
    store(value: string): Effect.Effect<void, SecretStoreError>;
    readonly remove: Effect.Effect<boolean, SecretStoreError>;
  }
>()("demur/key/TypeSafeApiKey") {
  static readonly layerNoDeps = Layer.effect(
    TypeSafeApiKey,
    Effect.gen(function* () {
      const environment = yield* Environment;
      const secrets = yield* SystemSecrets;

      const resolve = Effect.gen(function* () {
        const environmentValue = normalizeApiKey(
          yield* environment.get("TYPESAFE_API_KEY"),
        );
        if (environmentValue !== undefined) {
          return {
            value: environmentValue,
            source: "environment",
          } satisfies ResolvedApiKey;
        }

        const storedValue = normalizeApiKey(
          yield* secrets.get(TYPESAFE_SECRET.service, TYPESAFE_SECRET.name),
        );
        if (storedValue === undefined) return undefined;

        return {
          value: storedValue,
          source: "system",
        } satisfies ResolvedApiKey;
      });

      const store = Effect.fn("TypeSafeApiKey.store")(function* (value: string) {
        const normalized = normalizeApiKey(value);
        if (normalized === undefined) {
          return yield* new SecretStoreError({
            operation: "write",
            detail: "The TypeSafe API key cannot be empty.",
          });
        }

        yield* secrets.set(
          TYPESAFE_SECRET.service,
          TYPESAFE_SECRET.name,
          normalized,
        );
      });

      return TypeSafeApiKey.of({
        resolve,
        store,
        remove: secrets.delete(TYPESAFE_SECRET.service, TYPESAFE_SECRET.name),
      });
    }),
  );

  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Layer.merge(Environment.layer, SystemSecrets.layer)),
  );
}

const runtime = ManagedRuntime.make(TypeSafeApiKey.layer);

/**
 * Resolve the TypeSafe API key for a Promise-based host integration.
 *
 * @returns The active key and its source, or `undefined` when none is configured
 */
export function resolveApiKey(): Promise<ResolvedApiKey | undefined> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      return yield* apiKey.resolve;
    }),
  );
}

/**
 * Store a TypeSafe API key in the operating system credential store.
 *
 * @param value - The API key to persist
 * @returns A promise that completes after the credential is stored
 */
export function storeApiKey(value: string): Promise<void> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      return yield* apiKey.store(value);
    }),
  );
}

/**
 * Delete demur's TypeSafe API key from the operating system credential store.
 *
 * @returns Whether a stored credential existed
 */
export function deleteApiKey(): Promise<boolean> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      return yield* apiKey.remove;
    }),
  );
}

/**
 * What to tell the user when the key is missing.
 *
 * demur fails closed, so a missing key blocks every command. The message has to
 * name the fix, or the failure reads like a policy decision.
 */
export const MISSING_KEY_HELP =
  "No TypeSafe API key configured. Run `demur auth login`, set TYPESAFE_API_KEY, or inject it with a secret manager.";

function normalizeApiKey(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function secretStoreFailure(
  operation: SecretStoreError["operation"],
): (cause: unknown) => SecretStoreError {
  return (cause) =>
    new SecretStoreError({
      operation,
      detail: Predicate.isError(cause) ? cause.message : String(cause),
    });
}
