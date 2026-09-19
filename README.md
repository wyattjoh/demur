# demur

A proof-of-concept harmful-command guard for coding agents. demur sends a shell
command and limited execution context to TypeSafe System One, then turns six
model judgments into an `allow`, `ask`, or `deny` decision.

> [!WARNING]
> demur is experimental and is not a security boundary. A model can
> misclassify, behave nondeterministically, or be influenced by attacker-controlled
> command text. Use it as an additional confirmation layer, not as your only
> protection against harmful commands.

## How it works

For each agent-initiated Bash tool call, demur:

1. Collects the command, working directory, host name, and bounded Git facts.
2. Requests six judgments in one TypeSafe System One call:
   - whether the command executes a destructive operation;
   - whether it exposes secrets, credentials, or personal data;
   - whether it weakens a security boundary or grants elevated access;
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

Install demur's command-line tools and save your TypeSafe API key in the
operating system credential store:

```sh
bun add --global @wyattjoh/demur
demur auth login
demur auth status
```

`Bun.secrets` stores the credential in macOS Keychain, Linux Secret Service, or
Windows Credential Manager. The operating system may request access when the
credential is first used or while its credential store is locked.

For automation or a one-off override, set `TYPESAFE_API_KEY` before launching
the host agent. An environment value takes precedence over the stored key:

```sh
export TYPESAFE_API_KEY="..."
```

Never commit the key. [`.env.schema`](.env.schema) documents the accepted
environment configuration, and local environment files are ignored by Git.

### Pi

Install the npm package:

```sh
pi install npm:@wyattjoh/demur
```

Pin a specific release when reproducibility matters:

<!-- x-release-please-start-version -->
```sh
pi install npm:@wyattjoh/demur@0.3.2
```
<!-- x-release-please-end -->

Launch Pi normally after configuring the credential:

```sh
pi
```

The extension intercepts `bash` tool calls. Because Pi runs extensions under
Node.js while demur uses `Bun.secrets`, the extension launches a package-local
Bun worker for each judgment. The API key remains inside that worker; only the
command request and resulting verdict cross its local stdio pipes. `ask` opens
an interactive confirmation dialog; without an interactive UI, demur blocks the
command.

After each run, Pi's interactive UI prints the decision, submitted input-token
count, the run's estimated input cost, the accumulated global estimate, and the
wall-clock evaluation time in human-readable units. The
estimate uses TypeSafe's published Jev price of
[$0.042 per million input tokens](https://typesafe.ai/blog/introducing-system-one-models-and-jev);
it is informational rather than an authoritative billing amount. Failure and
bypass paths that do not call Jev report that cost is unavailable.

The accumulated estimate is stored at `$XDG_STATE_HOME/demur/usage.json`, or
`~/.local/state/demur/usage.json` when `XDG_STATE_HOME` is unset. A lock
serializes concurrent Pi instances, and each update is written to a temporary
file before an atomic rename so the total cannot be partially written or lose a
concurrent increment. Cost-accounting failures do not change demur's guard
decision; the status reports `accumulated unavailable` instead.

Pi packages execute with the user's full system permissions. Review this
repository before installing it.

For development, clone the repository and install it by local path:

```sh
git clone https://github.com/wyattjoh/demur.git
cd demur
bun install --frozen-lockfile
pi install "$PWD"
```

### Claude Code

The global package installation above also provides the Claude Code hook.
Register its executable in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "demur-claude-hook"
          }
        ]
      }
    ]
  }
}
```

Launch Claude Code normally after configuring the credential. The adapter emits
Claude Code's `hookSpecificOutput.permissionDecision` response.

### CLI

Manage the stored credential or judge a single command without a host
integration:

```sh
demur auth login
demur auth status
demur auth logout
demur judge "git reset --hard HEAD~3"
```

From a development checkout, `bun run judge "<command>"` remains available.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | stored credential | Optional TypeSafe API credential override. Missing keys fail closed. |
| `DEMUR_TIMEOUT_MS` | `4000` | Per-attempt model timeout in milliseconds. |
| `DEMUR_DISABLE` | unset | Emergency bypass. `1` or `true` allows every command. |

## Failure posture

demur fails closed. A missing key, credential-store failure, timeout, API
failure, malformed response, or unexpected guard error returns `deny` with a
reason that identifies the guard failure rather than presenting it as a policy
judgment.

`DEMUR_DISABLE=1` is an explicit emergency bypass. It disables all protection
and should remain unset during normal use.

## Known limitations

- `Bun.secrets` is experimental, and credential-store availability and prompts
  vary by operating system configuration.
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

- `src/questions.ts` — the six model judgments
- `src/policy.ts` — thresholds and `allow` / `ask` / `deny` composition
- `src/analyze.ts` — deterministic shell analysis for the static uncertainty gate
- `src/state.ts` — bounded environment and Git context collection
- `src/key.ts` — environment precedence and operating-system credential storage
- `src/guard.internal.ts` — Effect-native orchestration and fail-closed recovery
- `src/guard.ts` — managed runtime and Promise boundary
- `extensions/demur/` — Pi `tool_call` integration
- `src/adapters/claude-code.ts` — Claude Code `PreToolUse` integration
- `eval/` — safe synthetic contrast cases and the live evaluation runner

## Synthetic evaluation

The synthetic evaluation measures whether the two policy-qualification questions
separate clear positive and negative cases, then verifies that active hazards
produce a policy denial. Its 60 commands are hand-authored fixture strings with
synthetic names and no secret values. **The runner never executes a candidate
command.** It only sends each string and fixed synthetic context to TypeSafe.

Run one sample per case:

```sh
bun run eval:synthetic
```

Repeat each case (up to 10 samples) to expose model instability:

```sh
bun run eval:synthetic --runs=3
```

The command prints each case's expected and observed classification, exits
nonzero on a miss or provider failure, and writes full evidence to
`.scratch/synthetic-eval.json`. Repeated runs make additional provider calls and
may incur cost, so the live evaluation is deliberately not part of `bun run ci`.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

All three checks run together with `bun run ci`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes and
[RELEASING.md](RELEASING.md) for the automated release process. Report security
issues through [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
