# demur

A proof-of-concept destructive-command guard for coding agents. demur sends a
shell command and limited execution context to TypeSafe System One, then turns
four model judgments into an `allow`, `ask`, or `deny` decision.

> [!WARNING]
> demur is experimental and is not a security boundary. A model can
> misclassify, behave nondeterministically, or be influenced by attacker-controlled
> command text. Use it as an additional confirmation layer, not as your only
> protection against destructive commands.

## How it works

For each agent-initiated Bash tool call, demur:

1. Collects the command, working directory, host name, and bounded Git facts.
2. Requests four judgments in one TypeSafe System One call:
   - whether the command executes a destructive operation;
   - whether its effects are recoverable;
   - whether it targets shared infrastructure; and
   - its expected blast radius.
3. Applies deterministic thresholds from [`src/policy.ts`](src/policy.ts).
4. Escalates an otherwise allowed destructive command to `ask` when variables,
   globs, or command substitutions make its real target statically uncertain.
5. Maps the decision into Pi or Claude Code's permission protocol.

Environment access, Git queries, and network calls are Effect services. The
policy and shell analysis remain pure functions, while `src/guard.ts` exposes a
Promise boundary for host integrations.

## Data disclosure

Every judged command makes a request to TypeSafe. demur sends:

- the complete command string;
- the working directory;
- the requesting host (`pi` or `claude-code`);
- the repository root and current branch, when inside Git; and
- counts of modified, untracked, and unpushed changes plus whether an upstream
  branch exists.

demur does not send file contents, environment-variable values, remote URLs, or
its static-analysis result. Command strings and paths can still contain secrets
or sensitive names. Review TypeSafe's service terms and data-handling policy
before enabling demur in a sensitive repository. Do not run secrets directly in
shell arguments when the guard is active.

## Requirements

- [Bun](https://bun.sh/) 1.4 or newer
- A TypeSafe System One API key from <https://console.typesafe.ai/settings/keys>
- Network access to TypeSafe for every judged command
- Pi 0.85.x and/or Claude Code

## Install

Clone the repository and install its dependencies:

```sh
git clone https://github.com/wyattjoh/demur.git
cd demur
bun install --frozen-lockfile
```

Export the API key before launching the host agent. You can use your shell,
`.env.local` with a compatible environment loader, or any secret manager:

```sh
export TYPESAFE_API_KEY="..."
```

Never commit the key. [`.env.schema`](.env.schema) documents the accepted
configuration, and local environment files are ignored by Git.

### Pi

For a local checkout:

```sh
pi install /absolute/path/to/demur
```

After a release is tagged, install the pinned Git package:

```sh
pi install git:github.com/wyattjoh/demur@v0.1.0
```

Launch Pi from an environment that already contains `TYPESAFE_API_KEY`:

```sh
pi
```

The extension intercepts `bash` tool calls. `ask` opens an interactive
confirmation dialog; without an interactive UI, demur blocks the command.

Pi packages execute with the user's full system permissions. Review this
repository before installing it.

### Claude Code

Register the source adapter in `~/.claude/settings.json`, replacing the path
with the absolute path to your clone:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun /absolute/path/to/demur/src/adapters/claude-code.ts"
          }
        ]
      }
    ]
  }
}
```

Launch Claude Code from an environment that already contains
`TYPESAFE_API_KEY`. The adapter emits Claude Code's
`hookSpecificOutput.permissionDecision` response.

### CLI

Judge a single command without installing a host integration:

```sh
bun run judge "git reset --hard HEAD~3"
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe API credential. Missing keys fail closed. |
| `DEMUR_TIMEOUT_MS` | `4000` | Per-attempt model timeout in milliseconds. |
| `DEMUR_DISABLE` | unset | Emergency bypass. `1` or `true` allows every command. |

## Failure posture

demur fails closed. A missing key, timeout, API failure, malformed response, or
unexpected guard error returns `deny` with a reason that identifies the guard
failure rather than presenting it as a policy judgment.

`DEMUR_DISABLE=1` is an explicit emergency bypass. It disables all protection
and should remain unset during normal use.

## Known limitations

- Model decisions are probabilistic and may vary between identical requests.
- The hard-coded `jev-latest` model alias may change without a demur release.
- Attacker-controlled command text can influence the model.
- Shell expansion, obfuscation, aliases, wrappers, and runtime environment can
  make a command behave differently from its text.
- Network outages block commands unless the emergency bypass is enabled.
- Every decision adds remote-call latency and may incur provider cost.
- The integrations guard agent-issued Bash tool calls only. They do not guard
  user shells, other process-launching tools, or commands run outside the host.
- Other Pi extensions loaded after demur can mutate a tool call after it has been
  judged.

Use operating-system permissions, backups, repository protections, sandboxing,
and deterministic policy controls alongside demur.

## Project layout

- `src/questions.ts` — the four model judgments
- `src/policy.ts` — thresholds and `allow` / `ask` / `deny` composition
- `src/analyze.ts` — deterministic shell analysis for the static uncertainty gate
- `src/state.ts` — bounded environment and Git context collection
- `src/guard.internal.ts` — Effect-native orchestration and fail-closed recovery
- `src/guard.ts` — managed runtime and Promise boundary
- `extensions/demur/` — Pi `tool_call` integration
- `src/adapters/claude-code.ts` — Claude Code `PreToolUse` integration

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

All three checks run together with `bun run ci`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Report security
issues through [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
