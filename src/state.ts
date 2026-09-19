import { Context, Effect, Layer, Option, Schema } from "effect";
import { analyze, type CommandAnalysis } from "./analyze.ts";
import { Environment } from "./key.ts";
import type { CommandState, GitState, Host } from "./types.ts";

/**
 * A JSON object accepted by the Effect decision model as System One state.
 */
type JsonObject = { [key: string]: JsonValue };

/**
 * Any JSON-compatible value.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/**
 * Milliseconds to wait for git before giving up and judging without it.
 *
 * Git state is an enrichment, not a requirement: a slow or broken repository
 * must never delay the guard past its own budget.
 */
const GIT_TIMEOUT_MS = 400;

class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  cause: Schema.Defect(),
}) {}

/**
 * Effect service for the bounded git queries used to enrich command state.
 */
export class GitCommand extends Context.Service<
  GitCommand,
  {
    run(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string | undefined>;
  }
>()("demur/state/GitCommand") {
  static readonly layer = Layer.succeed(
    GitCommand,
    GitCommand.of({
      run: Effect.fn("GitCommand.run")(function* (
        cwd: string,
        args: ReadonlyArray<string>,
      ) {
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const proc = Bun.spawn(["git", ...args], {
              cwd,
              stdout: "pipe",
              stderr: "ignore",
              stdin: "ignore",
            });
            const abort = () => proc.kill();
            signal.addEventListener("abort", abort, { once: true });

            try {
              const [stdout, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                proc.exited,
              ]);
              return exitCode === 0 ? stdout.trim() : undefined;
            } finally {
              signal.removeEventListener("abort", abort);
            }
          },
          catch: (cause) => new GitCommandError({ cause }),
        }).pipe(
          Effect.timeoutOption(GIT_TIMEOUT_MS),
          Effect.map(Option.getOrUndefined),
          Effect.catch(() => Effect.succeed(undefined)),
        );
      }),
    }),
  );
}

/**
 * Collect the git facts that change whether a command is really destructive.
 *
 * Uses a single porcelain v2 status with branch headers, so this is one process
 * spawn rather than one per fact.
 *
 * @param cwd - Directory the command will run in
 * @returns Git state, or `undefined` when `cwd` is not inside a work tree
 */
export const gatherGitStateEffect = Effect.fn("gatherGitStateEffect")(function* (
  cwd: string,
): Effect.fn.Return<GitState | undefined, never, GitCommand> {
  const git = yield* GitCommand;
  const status = yield* git.run(cwd, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=normal",
  ]);
  if (status === undefined) return undefined;

  const root = yield* git.run(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) return undefined;

  let branch: string | undefined;
  let hasUpstream = false;
  let unpushedCommitCount = 0;
  let uncommittedFileCount = 0;
  let untrackedFileCount = 0;

  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? undefined : head;
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      // Format: "# branch.ab +<ahead> -<behind>"
      const ahead = line.slice("# branch.ab ".length).split(" ")[0];
      unpushedCommitCount = Math.max(0, Number(ahead ?? 0) || 0);
    } else if (line.startsWith("? ")) {
      untrackedFileCount += 1;
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      uncommittedFileCount += 1;
    }
  }

  return {
    root,
    branch,
    uncommittedFileCount,
    untrackedFileCount,
    unpushedCommitCount,
    hasUpstream,
  };
});

/**
 * Collect the git facts through the live Effect service.
 *
 * @param cwd - Directory the command will run in
 * @returns Git state, or `undefined` when `cwd` is not inside a work tree
 */
export function gatherGitState(cwd: string): Promise<GitState | undefined> {
  return Effect.runPromise(
    gatherGitStateEffect(cwd).pipe(Effect.provide(GitCommand.layer)),
  );
}

/**
 * Build the full state handed to the model for one command.
 *
 * @param command - The shell command about to run
 * @param cwd - Absolute working directory for the command
 * @param agent - Which coding agent is asking
 * @returns State ready to send as a System One request
 */
export const gatherStateEffect = Effect.fn("gatherStateEffect")(function* (
  command: string,
  cwd: string,
  agent: Host,
): Effect.fn.Return<CommandState, never, Environment | GitCommand> {
  const environment = yield* Environment;
  const [git, home, tmpDir] = yield* Effect.all([
    gatherGitStateEffect(cwd),
    environment.get("HOME"),
    environment.get("TMPDIR"),
  ]);

  return {
    command,
    cwd,
    agent,
    git,
    nonce: undefined,
    // Computed for the static gate in policy.ts, NOT sent to the model.
    // renderState below explains why it is withheld from the request.
    analysis: analyze(command, cwd, home ?? "/root", tmpDir?.replace(/\/$/, "")),
  };
});

/**
 * Build state through the live Effect services.
 *
 * @param command - The shell command about to run
 * @param cwd - Absolute working directory for the command
 * @param agent - Which coding agent is asking
 * @returns State ready to send as a System One request
 */
export function gatherState(
  command: string,
  cwd: string,
  agent: Host,
): Promise<CommandState> {
  return Effect.runPromise(
    gatherStateEffect(command, cwd, agent).pipe(
      Effect.provide(Layer.merge(Environment.layer, GitCommand.layer)),
    ),
  );
}

/**
 * Render state as the JSON object sent to the model.
 *
 * Field names are part of the prompt, so they are spelled out rather than
 * abbreviated, and git facts are flattened with a short explanation of what an
 * absent repository means.
 *
 * @param state - Collected command state
 * @returns A plain JSON object suitable for the `state` field
 */
export function renderState(state: CommandState): JsonObject {
  const out: JsonObject = {
    command: state.command,
    working_directory: state.cwd,
    requesting_agent: state.agent,
  };

  if (state.nonce !== undefined) out.request_nonce = state.nonce;

  out.version_control =
    state.git === undefined
      ? "Not inside a git repository."
      : {
          repository_root: state.git.root,
          current_branch: state.git.branch ?? "(detached HEAD)",
          uncommitted_modified_files: state.git.uncommittedFileCount,
          untracked_files: state.git.untrackedFileCount,
          unpushed_commits: state.git.unpushedCommitCount,
          branch_has_remote_upstream: state.git.hasUpstream,
        };

  // The static analysis in `analyze.ts` is deliberately NOT sent. It exists for
  // the deterministic policy gate; the model judges the original command rather
  // than a lossy summary of it.

  return out;
}

/**
 * Render the static analysis as state the model can read directly.
 *
 * Retained for deterministic policy and future hybrid guards. It is not part of
 * the model request; see {@link renderState}.
 *
 * The wording of each key is part of the prompt. `program` in particular is
 * spelled out as the real executable, because its whole purpose is to stop the
 * model from reading `rm` out of the middle of `transform`.
 *
 * @param analysis - Analysis produced by {@link analyze}
 * @returns A JSON object describing what code determined
 */
export function renderAnalysis(analysis: CommandAnalysis): JsonObject {
  const out: JsonObject = {
    note: "A breakdown of what this command will do when it runs. `program` is the executable that will actually be invoked, after removing quotes and stripping wrappers such as env or sudo. `paths` are resolved for ~, $TMPDIR, and .. before being located. Every command listed here executes.",
    commands: analysis.segments.map((segment) => {
      const entry: JsonObject = {
        program: segment.argv0 ?? "(could not determine)",
        arguments: segment.args,
      };
      if (segment.wrappers.length > 0) entry.invoked_through = segment.wrappers;
      if (segment.paths.length > 0) {
        entry.paths = segment.paths.map((p) => ({
          as_written: p.value,
          resolves_to: p.resolved ?? "(contains an unresolved variable)",
          location: p.class,
        }));
      }
      return entry;
    }),
  };

  if (analysis.substitutions.length > 0) {
    out.commands_inside_substitutions = analysis.substitutions;
  }

  if (analysis.heredocs.length > 0) {
    out.heredoc_bodies = analysis.heredocs.map((h) => ({
      delimiter: h.tag,
      fed_to: h.consumer ?? "(unknown)",
      shell_expansion_suppressed: h.quoted,
      body: h.body.length > 500 ? `${h.body.slice(0, 500)}…` : h.body,
    }));
  }

  if (!analysis.parsedCleanly) {
    out.parse_warning =
      "Part of this command could not be parsed cleanly; treat the breakdown above as incomplete.";
  }

  return out;
}
