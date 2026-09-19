# demur

A proof-of-concept destructive-command guard that judges commands with TypeSafe
System One. Read README.md for setup, data disclosure, and limitations.

## Layout

- `src/questions.ts` — the four judgments. **The highest-leverage file here.**
- `src/policy.ts` — thresholds and the allow/ask/deny composition.
- `src/analyze.ts` — deterministic shell analysis for the static uncertainty gate.
- `src/state.ts` — Effect services for environment and Git context gathering.
- `src/guard.internal.ts` — Effect-native orchestration and fail-closed posture.
- `src/guard.ts` — managed runtime and Promise compatibility boundary.
- `extensions/demur/` — Pi extension (`tool_call`).
- `src/adapters/claude-code.ts` — Claude Code `PreToolUse` hook.

## Credentials

`TYPESAFE_API_KEY` must already exist in the host process environment. demur
must not fetch or persist credentials. Users may export it directly or inject it
with a secret manager before launching Pi or Claude Code.

Declare configuration in `.env.schema`. Use `||` rather than `??` when an empty
environment value should fall back to a default.

## Conventions

- Bun + TypeScript. `bun run test`, `bun run check`, and `bun run build` must pass before committing.
- Effect, `@effect/vitest`, and `@effect/ai-typesafe` are pinned together at `4.0.0-rc.116`; do not update one without the others. This RC also requires Vitest 5.
- Keep host integrations Promise-based and run Effect programs through the managed runtime in `src/guard.ts`.
- Keep deterministic parsing and policy pure; put environment, process, and network access behind Effect services.
- Explicit `| undefined` over `?` optional markers.
- Multi-line JSDoc on every exported type and function.
- Keep README data-disclosure fields synchronized with `renderState()` in `src/state.ts`.

## Guard invariants

**Keep judgments and policy separate.** Raw model answers go in `Judgments`;
every threshold lives in `THRESHOLDS`.

**Review question design before blaming the model.** A judgment can faithfully
answer a poorly scoped question. Change one question at a time and validate it
against independently licensed fixtures.

**Do not pre-digest the command for the model.** The deterministic analyzer is
used by policy, not included in the model request. The model judges the original
command while code handles facts that can be resolved reliably.

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
