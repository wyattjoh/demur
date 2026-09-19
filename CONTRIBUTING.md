# Contributing

Thanks for helping improve demur. This is an experimental safety tool, so
changes should be small, reviewable, and explicit about their failure modes.

## Setup

Requirements:

- Bun 1.4 or newer
- A TypeSafe API key only when manually exercising live judgments

Install dependencies and run the local checks:

```sh
bun install --frozen-lockfile
bun run ci
```

The unit suite does not require an API key.

## Design constraints

- Keep raw judgments in `Judgments` and policy thresholds in `THRESHOLDS`.
- Keep parsing and policy deterministic and pure.
- Put environment, process, and network access behind Effect services.
- Preserve fail-closed behavior for missing credentials, timeouts, malformed
  responses, and unexpected errors.
- The static uncertainty gate may tighten `allow` to `ask`; it must never loosen
  a verdict.
- Keep the model-bound fields in `renderState()` synchronized with README's data
  disclosure.
- Use explicit `| undefined` unions and multi-line JSDoc for public exports.

## Tests

Add tests for behavior changes. Prefer service layers and deterministic fixtures
over live network calls. Before opening a pull request, run:

```sh
bun run check
bun run test
bun run build
```

Only contribute fixtures or benchmark data when the project has clear rights to
redistribute and evaluate them. Document provenance and licensing in the same
change.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md).

## Pull requests

Keep each pull request focused. Explain what changed, why it is safe, and which
failure paths were tested. By contributing, you agree that your contribution is
licensed under the project's MIT License.
