# demur

A proof-of-concept harmful-command guard that judges commands with TypeSafe
System One. Read README.md for setup, data disclosure, and limitations.

## Layout

- `src/questions.ts` — the six judgments. **The highest-leverage file here.**
- `src/policy.ts` — thresholds and the allow/ask/deny composition.
- `src/analyze.ts` — deterministic shell analysis for the static uncertainty gate.
- `src/state.ts` — Effect services for environment and Git context gathering.
- `src/key.ts` — environment precedence and `Bun.secrets` credential storage.
- `src/guard.internal.ts` — Effect-native orchestration and fail-closed posture.
- `src/guard.ts` — managed runtime and Promise compatibility boundary.
- `extensions/demur/` — Pi extension (`tool_call`).
- `src/adapters/claude-code.ts` — Claude Code `PreToolUse` hook.
- `eval/` — synthetic contrast corpus, pure scoring, and live runner.

## Credentials

`TYPESAFE_API_KEY` is the highest-priority credential source for automation and
one-off overrides. Otherwise, demur reads the TypeSafe API key from the
operating system credential store through `Bun.secrets`; users manage that item
with `demur auth login|status|logout`.

Keep environment and credential-store access behind Effect services. Never log,
print, or send the API key anywhere except the TypeSafe client. Declare
environment configuration in `.env.schema`. Use `||` rather than `??` when an
empty environment value should fall back to a default.

## Conventions

- Bun + TypeScript. `bun run test`, `bun run check`, and `bun run build` must pass before committing.
- Effect, `@effect/vitest`, and `@effect/ai-typesafe` are pinned together at `4.0.0-rc.116`; do not update one without the others. This RC also requires Vitest 5.
- Keep host integrations Promise-based and run Effect programs through the managed runtime in `src/guard.ts`.
- Keep deterministic parsing and policy pure; put environment, process, and network access behind Effect services.
- Explicit `| undefined` over `?` optional markers.
- Multi-line JSDoc on every exported type and function.
- Keep README data-disclosure fields synchronized with `renderState()` in `src/state.ts`.
- Run the complete quality gate with `bun run ci` before publishing.

## Releases

The npm package is `@wyattjoh/demur`. release-please owns version bumps,
`CHANGELOG.md`, tags, and GitHub releases after the manual `0.1.0` bootstrap.
Follow `RELEASING.md`; do not hand-edit release versions or tags during normal
operation.

The release workflow must keep npm publishing in the same workflow as
release-please because events created by `GITHUB_TOKEN` do not trigger separate
workflows. Publishing uses npm Trusted Publishing with OIDC, never a long-lived
npm token.

## Guard invariants

**Keep judgments and policy separate.** Raw model answers go in `Judgments`;
every threshold lives in `THRESHOLDS`.

**Review question design before blaming the model.** A judgment can faithfully
answer a poorly scoped question. Change one question at a time and validate it
against independently licensed fixtures.

**Do not pre-digest the command for the model.** The deterministic analyzer is
used by policy, not included in the model request. The model judges the original
command while code handles facts that can be resolved reliably.

**Do not infer authorization.** The originating user request is not part of the
model state. Questions must judge the command's objective effects, not whether
those effects were requested or permitted.

**Preserve fail-closed behavior.** Missing credentials, timeouts, malformed
responses, and unexpected errors deny the command. Only the explicit
`DEMUR_DISABLE` kill switch may bypass judgment.

## Static uncertainty gate

`src/analyze.ts` computes `staticallyUnresolvable`, consumed by
`applyStaticGate()`. The gate only escalates `allow` to `ask`; it must never
loosen a verdict. It is floored on `executesDestruction` so read-only commands
that merely contain a variable are not interrupted.

**Never add a separate `askX` threshold beside a `denyX` threshold.** Severity
signals use one threshold plus an uncertainty band so invalid threshold ordering
cannot make branches unreachable.

**Keep one copy of decision logic.** Tests and future evaluation tools must call
`decide()` rather than carrying a parallel implementation.

## Evaluation material

Only add fixtures and benchmark data with clear redistribution and evaluation
rights. Record their provenance and license. Do not copy third-party corpora into
this repository without explicit review.

Synthetic cases must use invented names and contain no real credentials or
personal data. Candidate commands are fixture strings: the eval runner may send
them to the judgment model but must never execute them. Keep live provider calls
out of `bun run ci`; use `bun run eval:synthetic` explicitly when measuring
question changes.
