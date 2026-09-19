import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  Environment,
  SystemSecrets,
  TypeSafeApiKey,
} from "./key.ts";

const environmentLayer = (values: Readonly<Record<string, string>>) =>
  Layer.succeed(
    Environment,
    Environment.of({
      get: Effect.fn("TestEnvironment.get")(function* (name: string) {
        return values[name];
      }),
    }),
  );

type SecretState = {
  value: string | undefined;
  getCalls: number;
};

const secretsLayer = (state: SecretState) =>
  Layer.succeed(
    SystemSecrets,
    SystemSecrets.of({
      get: Effect.fn("TestSystemSecrets.get")(function* (
        _service: string,
        _name: string,
      ) {
        state.getCalls += 1;
        return state.value;
      }),
      set: Effect.fn("TestSystemSecrets.set")(function* (
        _service: string,
        _name: string,
        value: string,
      ) {
        state.value = value;
      }),
      delete: Effect.fn("TestSystemSecrets.delete")(function* (
        _service: string,
        _name: string,
      ) {
        const existed = state.value !== undefined;
        state.value = undefined;
        return existed;
      }),
    }),
  );

const apiKeyLayer = (
  environment: Readonly<Record<string, string>>,
  secrets: SecretState,
) =>
  TypeSafeApiKey.layerNoDeps.pipe(
    Layer.provide(
      Layer.merge(environmentLayer(environment), secretsLayer(secrets)),
    ),
  );

describe("TypeSafe API key", () => {
  it.effect("prefers the environment without reading stored credentials", () => {
    const secrets = { value: "stored-key", getCalls: 0 };

    return Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      const resolved = yield* apiKey.resolve;

      assert.deepStrictEqual(resolved, {
        value: "environment-key",
        source: "environment",
      });
      assert.strictEqual(secrets.getCalls, 0);
    }).pipe(
      Effect.provide(
        apiKeyLayer({ TYPESAFE_API_KEY: " environment-key " }, secrets),
        { local: true },
      ),
    );
  });

  it.effect("falls back to the operating system credential store", () => {
    const secrets = { value: " stored-key ", getCalls: 0 };

    return Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      const resolved = yield* apiKey.resolve;

      assert.deepStrictEqual(resolved, {
        value: "stored-key",
        source: "system",
      });
      assert.strictEqual(secrets.getCalls, 1);
    }).pipe(
      Effect.provide(apiKeyLayer({}, secrets), { local: true }),
    );
  });

  it.effect("returns undefined when neither source has a key", () => {
    const secrets = { value: undefined, getCalls: 0 };

    return Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      assert.strictEqual(yield* apiKey.resolve, undefined);
    }).pipe(
      Effect.provide(
        apiKeyLayer({ TYPESAFE_API_KEY: "  " }, secrets),
        { local: true },
      ),
    );
  });

  it.effect("stores a trimmed key and deletes it", () => {
    const secrets = { value: undefined, getCalls: 0 };

    return Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      yield* apiKey.store(" stored-key ");
      assert.strictEqual(secrets.value, "stored-key");
      assert.isTrue(yield* apiKey.remove);
      assert.strictEqual(secrets.value, undefined);
      assert.isFalse(yield* apiKey.remove);
    }).pipe(
      Effect.provide(apiKeyLayer({}, secrets), { local: true }),
    );
  });

  it.effect("rejects an empty key", () => {
    const secrets = { value: undefined, getCalls: 0 };

    return Effect.gen(function* () {
      const apiKey = yield* TypeSafeApiKey;
      const result = yield* Effect.result(apiKey.store("  "));

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.operation, "write");
        assert.include(result.failure.detail, "cannot be empty");
      }
    }).pipe(
      Effect.provide(apiKeyLayer({}, secrets), { local: true }),
    );
  });
});
