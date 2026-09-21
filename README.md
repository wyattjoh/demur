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

Pi training capture stores the complete command, working directory, operating
mode, full verdict and judgments, and resulting host action locally. These
records can therefore contain secrets or sensitive names from shell arguments
and paths. Training capture is off by default and is unavailable while the Pi
integration is disabled.

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
pi install npm:@wyattjoh/demur@0.5.0
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

Use `/demur` to open the extension menu. Its global operating mode is:

- `enforce` (default) applies `allow`, `ask`, and `deny` decisions normally.
- `passive` still judges every Bash call and prints the diagnostic, but never
  prompts or blocks because of the verdict.
- `disabled` bypasses the worker and allows Bash calls without judgment.

Training capture can be enabled independently in `enforce` or `passive` mode.
It is automatically turned off when the integration is disabled. Pi's bottom
status bar always shows the current mode and whether training is active so every
bypass or local recording state remains visible.

The menu also controls what enforce mode does when demur cannot obtain a
trustworthy judgment because of a missing credential, timeout, API error,
malformed worker response, or unexpected guard failure:

- `block` (default) fails closed.
- `ask` requests interactive confirmation and blocks when no UI is available.
- `allow` fails open without confirmation.

Settings are stored globally at `$XDG_CONFIG_HOME/demur/config.json`, or
`~/.config/demur/config.json` when `XDG_CONFIG_HOME` is unset, and apply to
future Pi sessions. Set `DEMUR_CONFIG_HOME` to use an isolated demur directory;
`config.json` is read and written directly beneath it. This demur-specific
override takes precedence over the XDG and home-directory locations. While
demur is enforcing, the failure policy never changes a completed `deny` policy
judgment; those commands remain blocked. Passive mode reports failures but does
not apply the failure policy because it never blocks.

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

Training evaluations are appended as private, versioned JSONL records at
`$XDG_STATE_HOME/demur/training.jsonl`, with the same home-directory fallback.
Set `DEMUR_STATE_HOME` to place `usage.json`, `training.jsonl`, and
`training-reviews.jsonl` directly beneath an isolated directory instead. This
demur-specific override takes precedence over the XDG and home-directory
locations. Training records are retained until the user removes them. Human
reviews are appended separately; accepted and corrected records are linked by a
stable record ID, leaving the original evidence unchanged. A training-write
failure is reported but never changes whether the command runs.

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

Launch the central interface, manage the stored credential, or judge a single
command without a host integration:

```sh
demur
demur auth login
demur auth status
demur auth logout
demur training review
# Force the line-oriented interface for pipes or basic terminals:
demur training review --plain
demur judge "git reset --hard HEAD~3"
```

Bare `demur` opens the central OpenTUI interface when stdin and stdout are
interactive. `demur training review` remains an explicit alias for the same
interface. Its header shows the persisted global estimated cost, and each queue
row shows that evaluation's estimated input cost. It starts in an `all` view;
Tab and Shift-Tab rotate between `all`, `not reviewed`, `approved` (`allow`),
`ask`, and `deny` views. The queue is focused initially: arrow keys navigate it,
Up from its first result focuses a
fuzzy working-directory filter, and another Up focuses the tab strip. Left and
Right select adjacent focused tabs, while Down returns through the filter to the
queue. Right from the queue focuses the scrollable detail pane.
The detail pane supports arrows or `j`/`k`; Left returns to the queue. Page Up
and Page Down page within the focused pane, and queue navigation stops at its
first and last entries. Mouse clicks select tabs, records, the filter, or either
pane; the wheel scrolls the queue and detail pane. Enter selects the original
decision, `1`/`2`/`3` choose `allow`/`ask`/`deny`, `s`
leaves a record for a later pass, and `q` or Escape stops. Previously reviewed
records remain available, and changing an answer appends a review revision while
preserving its visible history. The TUI remains open when a view is empty and
polls training state for newly captured or externally reviewed evaluations.
Non-interactive invocations automatically use the line-oriented reviewer; pass
`--plain` to select it explicitly. Reviews remain separate from the original
evidence so they can later be curated into independently licensed eval fixtures.

From a development checkout, `bun run judge "<command>"` remains available.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | stored credential | Optional TypeSafe API credential override. Missing keys fail closed. |
| `DEMUR_TIMEOUT_MS` | `4000` | Per-attempt model timeout in milliseconds. |
| `DEMUR_CONFIG_HOME` | XDG/home config | Demur-specific directory containing `config.json`. |
| `DEMUR_STATE_HOME` | XDG/home state | Demur-specific directory containing usage and training state. |
| `DEMUR_DISABLE` | unset | Emergency bypass. `1` or `true` allows every command. |

## Failure posture

demur's core guard fails closed. A missing key, credential-store failure,
timeout, API failure, malformed response, or unexpected guard error returns
`deny` with a reason that identifies the guard failure rather than presenting it
as a policy judgment. The Claude Code adapter and CLI preserve that verdict.

The Pi extension defaults to enforce mode with the same fail-closed behavior,
but its explicit `/demur` menu can globally select enforce, passive, or disabled
mode. The failure-policy override applies only in enforce mode when no
trustworthy judgment was produced; it cannot loosen a completed policy denial.
Passive mode always continues after reporting the underlying verdict, while the
bottom status bar keeps the active mode and training state visible.

`DEMUR_DISABLE=1` remains the cross-host emergency bypass. It disables judgment
and protection entirely and should remain unset during normal use.

## Known limitations

- `Bun.secrets` is experimental, and credential-store availability and prompts
  vary by operating system configuration.
- Model decisions are probabilistic and may vary between identical requests.
- The hard-coded `jev-latest` model alias may change without a demur release.
- Attacker-controlled command text can influence the model.
- Shell expansion, obfuscation, aliases, wrappers, and runtime environment can
  make a command behave differently from its text.
- Network outages block commands by default; Pi can override that failure
  handling from the `/demur` menu.
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
- `src/training-review-model.ts` — historical review status and cwd filtering
- `src/training-review-tui.tsx` — interactive OpenTUI training-review queue
- `extensions/demur/` — Pi `tool_call` integration and training-state storage
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
