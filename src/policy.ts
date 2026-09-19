import type { CommandAnalysis } from "./analyze.ts";
import type { Decision, Judgments } from "./types.ts";

/**
 * Decision thresholds applied to raw judgments.
 *
 * Policy lives here, apart from the judgments themselves, so thresholds can be
 * retuned without changing the model questions or re-running inference.
 *
 * Each severity signal has a single deny threshold plus a shared uncertainty
 * band. There are deliberately no separate "ask" thresholds, which could cross
 * their corresponding deny thresholds and silently make branches unreachable.
 * One threshold plus a band cannot express that invalid configuration.
 */
export type Thresholds = {
  /**
   * Below this probability of actually executing something, the command is
   * treated as inert text and allowed outright. This is the gate that rescues
   * `grep "rm -rf"`, heredocs quoting dangerous strings, and `sed` scripts that
   * merely mention a scary path.
   */
  executesDestruction: number;
  /**
   * Probability of exposing sensitive values at which a command is denied.
   */
  denySensitiveDataExposure: number;
  /**
   * Probability of weakening a security boundary at which a command is denied.
   */
  denySecurityBoundaryWeakening: number;
  /**
   * Probability of unrecoverable loss at which a command is denied.
   */
  denyUnrecoverable: number;
  /**
   * Probability of touching shared or production systems at which a command is
   * denied.
   */
  denySharedInfrastructure: number;
  /**
   * Expected blast radius at which a command is denied, on the 0–3 rubric.
   */
  denyBlastRadius: number;
  /**
   * Blast-radius confidence below which a destructive command is escalated to a
   * prompt rather than allowed. An uncertain model on a destructive command is
   * exactly the case a human should see.
   */
  minBlastRadiusConfidence: number;
  /**
   * Half-width of the uncertainty band around each probability threshold.
   *
   * Model judgments are not deterministic. Anything inside the band becomes
   * `ask`, turning a borderline automatic decision into a question for the user.
   */
  uncertaintyBand: number;
  /**
   * The same band for the 0–3 blast-radius scale rather than a probability.
   */
  uncertaintyBandScore: number;
  /**
   * How destructive a command must look before an unresolvable target escalates
   * it to a prompt.
   *
   * Without this floor the static gate also fires on `test -d "$p/.git"` and
   * `command -v git` — read-only commands that merely contain a variable.
   */
  staticGateMinExecution: number;
};

/**
 * Shipped thresholds.
 *
 * These are proof-of-concept defaults, not safety guarantees. Re-validate them
 * against your own threat model and command distribution.
 */
export const THRESHOLDS: Thresholds = {
  executesDestruction: 0.3,
  denySensitiveDataExposure: 0.45,
  denySecurityBoundaryWeakening: 0.45,
  denyUnrecoverable: 0.45,
  denySharedInfrastructure: 0.5,
  denyBlastRadius: 2.0,
  minBlastRadiusConfidence: 0.5,
  uncertaintyBand: 0.04,
  uncertaintyBandScore: 0.12,
  staticGateMinExecution: 0.8,
};

/**
 * A decision plus the sentence explaining it.
 */
export type PolicyOutcome = {
  /**
   * The action to take.
   */
  decision: Decision;
  /**
   * Justification naming the signal that drove the decision.
   */
  reason: string;
};

/**
 * Turn raw judgments into an action.
 *
 * Order matters. Sensitive-data exposure and security-boundary weakening run
 * before the inert-text gate because a read-only command can still disclose a
 * secret. Their uncertainty bands also run before that gate. The destructive
 * severity signals are checked only after the command is known to change state.
 *
 * @param j - Judgments returned for the command
 * @param t - Threshold set to apply; defaults to the shipped values
 * @returns The decision and the reason behind it
 */
export function decide(j: Judgments, t: Thresholds = THRESHOLDS): PolicyOutcome {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const band = t.uncertaintyBand;
  const scoreBand = t.uncertaintyBandScore;

  if (j.exposesSensitiveData >= t.denySensitiveDataExposure + band) {
    return {
      decision: "deny",
      reason: `May expose sensitive data such as secrets, credentials, or personal information (${pct(j.exposesSensitiveData)} likelihood). Use a redacted or metadata-only command.`,
    };
  }

  if (
    j.weakensSecurityBoundary >=
    t.denySecurityBoundaryWeakening + band
  ) {
    return {
      decision: "deny",
      reason: `May weaken or bypass a security boundary or grant elevated access (${pct(j.weakensSecurityBoundary)} likelihood). Run it yourself if that is intended.`,
    };
  }

  if (j.exposesSensitiveData >= t.denySensitiveDataExposure - band) {
    return {
      decision: "ask",
      reason: `Borderline on whether this exposes sensitive values (${pct(j.exposesSensitiveData)}). Confirm that its output and destination are safe.`,
    };
  }

  if (
    j.weakensSecurityBoundary >=
    t.denySecurityBoundaryWeakening - band
  ) {
    return {
      decision: "ask",
      reason: `Borderline on whether this weakens a security boundary or grants elevated access (${pct(j.weakensSecurityBoundary)}).`,
    };
  }

  if (j.executesDestruction < t.executesDestruction - band) {
    return {
      decision: "allow",
      reason: `No destructive operation is actually executed (${pct(j.executesDestruction)} likelihood); any dangerous-looking text is inert.`,
    };
  }

  if (j.targetsSharedInfrastructure >= t.denySharedInfrastructure + band) {
    return {
      decision: "deny",
      reason: `Acts on shared or production infrastructure (${pct(j.targetsSharedInfrastructure)} likelihood). Run it yourself if that is intended.`,
    };
  }

  if (j.unrecoverable >= t.denyUnrecoverable + band) {
    return {
      decision: "deny",
      reason: `Destroys work that cannot be recovered (${pct(j.unrecoverable)} likelihood). Commit, stash, or back up first.`,
    };
  }

  if (j.blastRadius >= t.denyBlastRadius + scoreBand) {
    return {
      decision: "deny",
      reason: `Blast radius ${j.blastRadius.toFixed(1)}/3 — at this level the loss reaches irreplaceable or shared state.`,
    };
  }

  // Inside a band: the signal is too close to its threshold for the decision to
  // be reproducible, so ask rather than flip a coin on the user's behalf.
  if (j.targetsSharedInfrastructure >= t.denySharedInfrastructure - band) {
    return {
      decision: "ask",
      reason: `Borderline on whether this touches shared or production infrastructure (${pct(j.targetsSharedInfrastructure)}).`,
    };
  }

  if (j.unrecoverable >= t.denyUnrecoverable - band) {
    return {
      decision: "ask",
      reason: `Borderline on whether the loss is recoverable (${pct(j.unrecoverable)}).`,
    };
  }

  if (j.blastRadius >= t.denyBlastRadius - scoreBand) {
    return {
      decision: "ask",
      reason: `Blast radius ${j.blastRadius.toFixed(1)}/3, right at the line where the loss stops being contained.`,
    };
  }

  if (j.blastRadiusConfidence < t.minBlastRadiusConfidence) {
    return {
      decision: "ask",
      reason: `Destructive, and the blast radius is unclear (confidence ${j.blastRadiusConfidence.toFixed(2)}). Escalating rather than guessing.`,
    };
  }

  if (j.executesDestruction < t.executesDestruction + band) {
    return {
      decision: "ask",
      reason: `Borderline on whether this executes anything at all (${pct(j.executesDestruction)}).`,
    };
  }

  return {
    decision: "allow",
    reason: `Destructive but contained: blast radius ${j.blastRadius.toFixed(1)}/3, ${pct(j.unrecoverable)} chance of unrecoverable loss.`,
  };
}

/**
 * Refuse to allow a destructive command whose real target cannot be known.
 *
 * Some commands do not determine their own effect. A delete rooted at `$TMPDIR`
 * removes whatever that variable happens to name. A glob in the program position
 * depends on what it expands to. A command substitution runs whatever it prints.
 *
 * A judgment answers what a command *appears* to do. Where appearance and effect
 * can diverge, that answer is not a basis for allowing it automatically, so the
 * decision is floored at `ask`. Denials stand; this can only tighten a verdict.
 *
 * @param outcome - The decision reached from the judgments alone
 * @param analysis - Static analysis of the same command
 * @param judgments - The raw judgments, for the destructiveness floor
 * @param t - Threshold set to apply; defaults to the shipped values
 * @returns The outcome, escalated to `ask` when the target is unknowable
 */
export function applyStaticGate(
  outcome: PolicyOutcome,
  analysis: CommandAnalysis | undefined,
  judgments: Judgments,
  t: Thresholds = THRESHOLDS,
): PolicyOutcome {
  if (analysis === undefined) return outcome;
  if (outcome.decision !== "allow") return outcome;
  if (!analysis.staticallyUnresolvable) return outcome;
  if (judgments.executesDestruction < t.staticGateMinExecution) return outcome;

  return {
    decision: "ask",
    reason:
      "Destructive, and what it actually targets depends on the environment — a variable, a glob, or a command substitution — rather than on the command text. Confirm before running.",
  };
}
