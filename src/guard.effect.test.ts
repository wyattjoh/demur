import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { guardEffect, judgeStateEffect } from "./guard.internal.ts";
import {
  Judgment,
  JudgmentError,
  type JudgeSuccess,
} from "./judge.ts";
import {
  Environment,
  SecretStoreError,
  TypeSafeApiKey,
} from "./key.ts";
import { gatherStateEffect, GitCommand } from "./state.ts";
import type { CommandState, Judgments } from "./types.ts";

const safeJudgments: Judgments = {
  executesDestruction: 0,
  unrecoverable: 0,
  targetsSharedInfrastructure: 0,
  blastRadius: 0,
  blastRadiusConfidence: 1,
};

const successfulJudgment: JudgeSuccess = {
  ok: true,
  judgments: safeJudgments,
  usage: { inputTokens: 12, outputTokens: 3 },
};

const environmentLayer = (values: Readonly<Record<string, string>>) =>
  Layer.succeed(
    Environment,
    Environment.of({
      get: Effect.fn("TestEnvironment.get")(function* (name: string) {
        return values[name];
      }),
    }),
  );

const gitLayer = (outputs: Readonly<Record<string, string>> = {}) =>
  Layer.succeed(
    GitCommand,
    GitCommand.of({
      run: Effect.fn("TestGitCommand.run")(function* (
        _cwd: string,
        args: ReadonlyArray<string>,
      ) {
        return outputs[args.join(" ")];
      }),
    }),
  );

const judgmentLayer = (
  result: Effect.Effect<JudgeSuccess, JudgmentError>,
) =>
  Layer.succeed(
    Judgment,
    Judgment.of({
      judge: Effect.fn("TestJudgment.judge")(function* (
        _state: CommandState,
      ) {
        return yield* result;
      }),
    }),
  );

const apiKeyLayer = (
  resolved: Effect.Effect<
    { value: string; source: "environment" | "system" } | undefined,
    SecretStoreError
  >,
) =>
  Layer.succeed(
    TypeSafeApiKey,
    TypeSafeApiKey.of({
      resolve: resolved,
      store: Effect.fn("TestTypeSafeApiKey.store")(function* (
        _value: string,
      ) {}),
      remove: Effect.succeed(false),
    }),
  );

const guardLayer = (
  values: Readonly<Record<string, string>>,
  result: Effect.Effect<JudgeSuccess, JudgmentError>,
) =>
  Layer.mergeAll(
    environmentLayer(values),
    gitLayer(),
    judgmentLayer(result),
  );

const state: CommandState = {
  command: "echo safe",
  cwd: "/workspace",
  agent: "cli",
  git: undefined,
  nonce: undefined,
  analysis: undefined,
};

describe("Effect guard", () => {
  it.effect("bypasses every dependency when disabled", () => {
    let judgmentCalls = 0;
    const judgment = Effect.sync(() => {
      judgmentCalls += 1;
      return successfulJudgment;
    });

    return Effect.gen(function* () {
      const verdict = yield* guardEffect("rm -rf /", "/workspace", "pi");

      assert.strictEqual(verdict.decision, "allow");
      assert.include(verdict.reason, "disabled via DEMUR_DISABLE");
      assert.strictEqual(judgmentCalls, 0);
    }).pipe(
      Effect.provide(
        guardLayer({ DEMUR_DISABLE: "1" }, judgment),
        { local: true },
      ),
    );
  });

  it.effect("turns a successful judgment into a policy verdict", () =>
    Effect.gen(function* () {
      const verdict = yield* guardEffect("echo safe", "/workspace", "cli");

      assert.strictEqual(verdict.decision, "allow");
      assert.deepStrictEqual(verdict.judgments, safeJudgments);
      assert.deepStrictEqual(verdict.usage, { inputTokens: 12, outputTokens: 3 });
      assert.strictEqual(verdict.failure, undefined);
    }).pipe(
      Effect.provide(
        guardLayer({}, Effect.succeed(successfulJudgment)),
        { local: true },
      ),
    ),
  );

  it.effect("fails closed on a typed judgment failure", () =>
    Effect.gen(function* () {
      const verdict = yield* judgeStateEffect(state);

      assert.strictEqual(verdict.decision, "deny");
      assert.strictEqual(verdict.failure, "timeout");
      assert.include(verdict.reason, "guard unavailable (timeout)");
    }).pipe(
      Effect.provide(
        judgmentLayer(
          Effect.fail(
            new JudgmentError({ failure: "timeout", detail: "timed out" }),
          ),
        ),
        { local: true },
      ),
    ),
  );

  it.effect("fails closed when the credential store cannot be read", () =>
    Effect.gen(function* () {
      const verdict = yield* judgeStateEffect(state);

      assert.strictEqual(verdict.decision, "deny");
      assert.strictEqual(verdict.failure, "credential-error");
      assert.include(verdict.reason, "credential store");
      assert.include(verdict.reason, "keychain locked");
    }).pipe(
      Effect.provide(
        Judgment.layerNoDeps.pipe(
          Layer.provide(
            Layer.merge(
              environmentLayer({}),
              apiKeyLayer(
                Effect.fail(
                  new SecretStoreError({
                    operation: "read",
                    detail: "keychain locked",
                  }),
                ),
              ),
            ),
          ),
        ),
        { local: true },
      ),
    ),
  );

  it.effect("fails closed on a service defect", () =>
    Effect.gen(function* () {
      const verdict = yield* judgeStateEffect(state);

      assert.strictEqual(verdict.decision, "deny");
      assert.strictEqual(verdict.failure, "unexpected");
      assert.include(verdict.reason, "boom");
    }).pipe(
      Effect.provide(
        judgmentLayer(Effect.die(new Error("boom"))),
        { local: true },
      ),
    ),
  );
});

describe("Effect state gathering", () => {
  it.effect("collects git and environment context through services", () => {
    const outputs = {
      "status --porcelain=v2 --branch --untracked-files=normal": [
        "# branch.head feature/effect",
        "# branch.upstream origin/feature/effect",
        "# branch.ab +2 -0",
        "1 .M N... 100644 100644 100644 abc abc src/a.ts",
        "? src/new.ts",
      ].join("\n"),
      "rev-parse --show-toplevel": "/workspace",
    };

    return Effect.gen(function* () {
      const gathered = yield* gatherStateEffect(
        "rm -rf $TMPDIR/build",
        "/workspace",
        "pi",
      );

      assert.deepStrictEqual(gathered.git, {
        root: "/workspace",
        branch: "feature/effect",
        uncommittedFileCount: 1,
        untrackedFileCount: 1,
        unpushedCommitCount: 2,
        hasUpstream: true,
      });
      assert.strictEqual(
        gathered.analysis?.segments[0]?.paths[0]?.class,
        "temp",
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          environmentLayer({ HOME: "/home/test", TMPDIR: "/tmp/test/" }),
          gitLayer(outputs),
        ),
        { local: true },
      ),
    );
  });
});
