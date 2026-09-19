import type { CommandAnalysis } from "./analyze.ts";

/**
 * The coding agent that is about to run the command.
 */
export type Host = "pi" | "claude-code" | "cli";

/**
 * Everything demur knows about a command before judging it.
 *
 * This is handed to the model verbatim as System One state, so every field is
 * named the way we want the model to read it.
 */
export type CommandState = {
  /**
   * The exact shell command the agent is about to execute.
   */
  command: string;
  /**
   * Absolute working directory the command will run in.
   */
  cwd: string;
  /**
   * Which coding agent requested the command.
   */
  agent: Host;
  /**
   * Git facts about `cwd`, or `undefined` when it is not a work tree.
   */
  git: GitState | undefined;
  /**
   * Throwaway unique value included in the request, used only by the stability
   * harness so repeated calls are sampled independently rather than served from
   * a cache. `undefined` in normal operation.
   */
  nonce: string | undefined;
  /**
   * What code could determine about the command without running it.
   *
   * Deterministic parsing the model should not have to do by eye: real program
   * names, resolved paths, heredoc bodies, command substitutions.
   */
  analysis: CommandAnalysis | undefined;
};

/**
 * Git working-tree facts that change whether a command is actually destructive.
 *
 * `git reset --hard` destroys nothing in a clean tree; it destroys hours of
 * work in a dirty one. Rules cannot see that difference, so we measure it.
 */
export type GitState = {
  /**
   * Absolute path to the repository root.
   */
  root: string;
  /**
   * Current branch name, or `undefined` when detached.
   */
  branch: string | undefined;
  /**
   * Number of files with staged or unstaged modifications.
   */
  uncommittedFileCount: number;
  /**
   * Number of untracked files, which no git command can recover.
   */
  untrackedFileCount: number;
  /**
   * Commits on the current branch not present on its upstream, which are lost
   * if the branch is reset or force-deleted.
   */
  unpushedCommitCount: number;
  /**
   * Whether the branch has an upstream to recover from.
   */
  hasUpstream: boolean;
};

/**
 * The raw judgments returned for one command, before policy is applied.
 *
 * These are kept separate from the verdict so thresholds can change without
 * re-running inference.
 */
export type Judgments = {
  /**
   * Probability the command actually performs a destructive operation, rather
   * than merely containing destructive-looking text as data.
   */
  executesDestruction: number;
  /**
   * Probability that what it destroys cannot be recovered.
   */
  unrecoverable: number;
  /**
   * Probability it acts on shared, remote, or production systems.
   */
  targetsSharedInfrastructure: number;
  /**
   * Expected blast radius from 0 (ephemeral) to 3 (remote or production).
   */
  blastRadius: number;
  /**
   * Model confidence in `blastRadius`, from 0 to 1.
   */
  blastRadiusConfidence: number;
};

/**
 * What demur decided to do with a command.
 */
export type Decision = "allow" | "ask" | "deny";

/**
 * Why demur could not reach a judgment, when it had to fall back.
 */
export type FailureKind =
  | "no-api-key"
  | "credential-error"
  | "timeout"
  | "api-error"
  | "unexpected";

/**
 * A complete guard result, including the evidence behind it.
 */
export type Verdict = {
  /**
   * The action the host should take.
   */
  decision: Decision;
  /**
   * Human-readable justification, shown to the agent and the user.
   */
  reason: string;
  /**
   * The judgments the decision was derived from, or `undefined` when the guard
   * failed closed without reaching the model.
   */
  judgments: Judgments | undefined;
  /**
   * Set when the decision came from a failure path rather than a judgment.
   */
  failure: FailureKind | undefined;
  /**
   * Wall-clock milliseconds the guard took end to end.
   */
  latencyMs: number;
  /**
   * Token usage for the judgment call, when one completed.
   */
  usage: { inputTokens: number; outputTokens: number } | undefined;
};
