import type {
  TrainingCorrectionReason,
  TrainingRecord,
} from "../extensions/demur/training-store.ts";
import type { JudgeResult } from "./judge.ts";
import { applyStaticGate, decide, THRESHOLDS, type Thresholds } from "./policy.ts";
import {
  getLatestTrainingReview,
  getTrainingCorrectionReason,
  type TrainingReviewEntry,
} from "./training-review-model.ts";
import type {
  Decision,
  Judgments,
  RenderedCommandState,
} from "./types.ts";

/**
 * Decision-by-decision counts for one threshold evaluation.
 */
export type TrainingDecisionMatrix = Readonly<
  Record<Decision, Readonly<Record<Decision, number>>>
>;

/**
 * Aggregate quality and safety metrics for one threshold set.
 */
export type TrainingThresholdMetrics = {
  evaluated: number;
  matches: number;
  corrections: number;
  weightedLoss: number;
  matrix: TrainingDecisionMatrix;
};

/**
 * One exploratory single-threshold change that improves observed weighted loss.
 */
export type TrainingThresholdCandidate = {
  field: keyof Thresholds;
  value: number;
  metrics: TrainingThresholdMetrics;
};

/**
 * Offline report derived only from locally persisted judgments and reviews.
 */
export type TrainingFeedbackReport = {
  reviewed: number;
  evaluable: number;
  unavailable: number;
  completeReplayRecords: number;
  policyOnlyRecords: number;
  correctionsByReason: Readonly<
    Partial<Record<TrainingCorrectionReason, number>>
  >;
  current: TrainingThresholdMetrics;
  candidates: ReadonlyArray<TrainingThresholdCandidate>;
  warning: string | undefined;
};

/**
 * Adapter used to run the current TypeSafe questions against captured state.
 */
export type TrainingReplayJudge = (
  state: RenderedCommandState,
) => Promise<JudgeResult>;

/**
 * One reviewed record's live question-replay result.
 */
export type TrainingQuestionReplaySample = {
  recordId: string;
  expectedDecision: Decision;
  originalDecision: Decision;
  replayedDecision: Decision | undefined;
  judgments: Judgments | undefined;
  failure: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};

/**
 * Aggregate comparison of the current question set with reviewed outcomes.
 */
export type TrainingQuestionReplayReport = {
  replayable: number;
  unavailable: number;
  skipped: number;
  improved: number;
  regressed: number;
  metrics: TrainingThresholdMetrics;
  inputTokens: number;
  outputTokens: number;
  samples: ReadonlyArray<TrainingQuestionReplaySample>;
};

const MIN_RECOMMENDATION_SAMPLE = 20;

/**
 * Evaluate reviewed training records and search safe, one-field threshold alternatives.
 *
 * Candidate values are advisory only. They are selected against the same records
 * used to score them and must be validated on an independent holdout before any
 * policy change is promoted.
 *
 * @param entries - Training records paired with complete append-only review history
 * @param thresholds - Current policy thresholds used as the comparison baseline
 * @returns Current metrics, correction clusters, and exploratory candidates
 */
export function analyzeTrainingFeedback(
  entries: ReadonlyArray<TrainingReviewEntry>,
  thresholds: Thresholds = THRESHOLDS,
): TrainingFeedbackReport {
  const reviewed = entries.filter((entry) =>
    getLatestTrainingReview(entry) !== undefined
  );
  const evaluable = reviewed.filter((entry) =>
    entry.record.verdict.judgments !== undefined
  );
  const completeReplayRecords = evaluable.filter(hasCompleteReplayEvidence)
    .length;
  const current = evaluateThresholds(evaluable, thresholds);
  const correctionsByReason = countCorrectionReasons(reviewed);

  return {
    reviewed: reviewed.length,
    evaluable: evaluable.length,
    unavailable: reviewed.length - evaluable.length,
    completeReplayRecords,
    policyOnlyRecords: evaluable.length - completeReplayRecords,
    correctionsByReason,
    current,
    candidates: findImprovingCandidates(evaluable, thresholds, current),
    warning: evaluable.length < MIN_RECOMMENDATION_SAMPLE
      ? `Only ${evaluable.length} reviewed records have judgments; collect at least ${MIN_RECOMMENDATION_SAMPLE} before treating threshold candidates as meaningful.`
      : undefined,
  };
}

/**
 * Score one threshold set against the latest human answer for each record.
 *
 * @param entries - Reviewed entries with usable raw judgments
 * @param thresholds - Candidate policy thresholds
 * @returns Decision matrix and asymmetrically weighted correction loss
 */
export function evaluateThresholds(
  entries: ReadonlyArray<TrainingReviewEntry>,
  thresholds: Thresholds,
): TrainingThresholdMetrics {
  const matrix = emptyDecisionMatrix();
  let evaluated = 0;
  let matches = 0;
  let weightedLoss = 0;

  for (const entry of entries) {
    const review = getLatestTrainingReview(entry);
    const judgments = entry.record.verdict.judgments;
    if (review === undefined || judgments === undefined) continue;

    const actual = replayDecision(entry.record, thresholds);
    const expected = review.expectedDecision;
    matrix[expected][actual] += 1;
    evaluated += 1;
    if (actual === expected) matches += 1;
    weightedLoss += decisionLoss(expected, actual);
  }

  return {
    evaluated,
    matches,
    corrections: evaluated - matches,
    weightedLoss,
    matrix,
  };
}

/**
 * Re-run the current TypeSafe question set against exact captured state.
 *
 * Candidate commands remain JSON state and are never executed. The caller is
 * responsible for making the cost-bearing TypeSafe request explicit to users.
 *
 * @param entries - Reviewed training history
 * @param judge - Live judgment adapter for exact rendered state
 * @param limit - Maximum cost-bearing TypeSafe requests in this replay
 * @param thresholds - Policy thresholds applied to replayed raw judgments
 * @returns Per-record evidence and aggregate improvement/regression metrics
 */
export async function replayTrainingQuestions(
  entries: ReadonlyArray<TrainingReviewEntry>,
  judge: TrainingReplayJudge,
  limit = 20,
  thresholds: Thresholds = THRESHOLDS,
): Promise<TrainingQuestionReplayReport> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("training replay limit must be a positive integer");
  }
  const samples: Array<TrainingQuestionReplaySample> = [];
  const matrix = emptyDecisionMatrix();
  let unavailable = 0;
  let skipped = 0;
  let attempted = 0;
  let improved = 0;
  let regressed = 0;
  let matches = 0;
  let weightedLoss = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const entry of entries) {
    const review = getLatestTrainingReview(entry);
    if (review === undefined) continue;
    if (entry.record.version !== 2 || entry.record.evidence === undefined) {
      unavailable += 1;
      continue;
    }
    if (attempted >= limit) {
      skipped += 1;
      continue;
    }

    attempted += 1;
    const result = await judge(entry.record.evidence.modelState);
    if (!result.ok) {
      unavailable += 1;
      samples.push({
        recordId: entry.record.id,
        expectedDecision: review.expectedDecision,
        originalDecision: entry.record.verdict.decision,
        replayedDecision: undefined,
        judgments: undefined,
        failure: `${result.failure}: ${result.detail}`,
        inputTokens: undefined,
        outputTokens: undefined,
      });
      continue;
    }

    const base = decide(result.judgments, thresholds);
    const replayedDecision = applyStaticGate(
      base,
      entry.record.evidence.analysis,
      result.judgments,
      thresholds,
    ).decision;
    const expected = review.expectedDecision;
    const originalMatched = entry.record.verdict.decision === expected;
    const replayMatched = replayedDecision === expected;
    if (!originalMatched && replayMatched) improved += 1;
    if (originalMatched && !replayMatched) regressed += 1;
    if (replayMatched) matches += 1;
    weightedLoss += decisionLoss(expected, replayedDecision);
    matrix[expected][replayedDecision] += 1;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    samples.push({
      recordId: entry.record.id,
      expectedDecision: expected,
      originalDecision: entry.record.verdict.decision,
      replayedDecision,
      judgments: result.judgments,
      failure: undefined,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  const evaluated = samples.filter((sample) =>
    sample.replayedDecision !== undefined
  ).length;
  return {
    replayable: evaluated,
    unavailable,
    skipped,
    improved,
    regressed,
    metrics: {
      evaluated,
      matches,
      corrections: evaluated - matches,
      weightedLoss,
      matrix,
    },
    inputTokens,
    outputTokens,
    samples,
  };
}

function replayDecision(
  record: TrainingRecord,
  thresholds: Thresholds,
): Decision {
  const judgments = record.verdict.judgments;
  if (judgments === undefined) return record.verdict.decision;

  const outcome = decide(judgments, thresholds);
  if (record.version === 1 || record.evidence?.analysis === undefined) {
    return outcome.decision;
  }
  return applyStaticGate(
    outcome,
    record.evidence.analysis,
    judgments,
    thresholds,
  ).decision;
}

function hasCompleteReplayEvidence(entry: TrainingReviewEntry): boolean {
  return entry.record.version === 2 &&
    entry.record.evidence?.analysis !== undefined;
}

function countCorrectionReasons(
  entries: ReadonlyArray<TrainingReviewEntry>,
): Partial<Record<TrainingCorrectionReason, number>> {
  const counts: Partial<Record<TrainingCorrectionReason, number>> = {};
  for (const entry of entries) {
    const review = getLatestTrainingReview(entry);
    if (
      review === undefined ||
      review.expectedDecision === entry.record.verdict.decision
    ) {
      continue;
    }
    const reason = getTrainingCorrectionReason(review);
    if (reason !== undefined) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function findImprovingCandidates(
  entries: ReadonlyArray<TrainingReviewEntry>,
  thresholds: Thresholds,
  current: TrainingThresholdMetrics,
): ReadonlyArray<TrainingThresholdCandidate> {
  if (entries.length === 0) return [];

  const candidates: Array<TrainingThresholdCandidate> = [];
  for (const [field, values] of thresholdCandidateValues()) {
    for (const value of values) {
      if (value === thresholds[field]) continue;
      const candidateThresholds = { ...thresholds, [field]: value };
      const metrics = evaluateThresholds(entries, candidateThresholds);
      if (metrics.weightedLoss >= current.weightedLoss) continue;
      candidates.push({ field, value, metrics });
    }
  }

  return candidates
    .sort((left, right) =>
      left.metrics.weightedLoss - right.metrics.weightedLoss ||
      left.metrics.corrections - right.metrics.corrections ||
      left.field.localeCompare(right.field) ||
      left.value - right.value
    )
    .slice(0, 5);
}

function thresholdCandidateValues(): ReadonlyArray<
  readonly [keyof Thresholds, ReadonlyArray<number>]
> {
  const probabilities = numericRange(0.05, 0.95, 0.05);
  return [
    ["executesDestruction", probabilities],
    ["denySensitiveDataExposure", probabilities],
    ["denySecurityBoundaryWeakening", probabilities],
    ["denyUnrecoverable", probabilities],
    ["denySharedInfrastructure", probabilities],
    ["denyBlastRadius", numericRange(0.5, 3, 0.1)],
    ["minBlastRadiusConfidence", probabilities],
    ["uncertaintyBand", numericRange(0, 0.15, 0.01)],
    ["uncertaintyBandScore", numericRange(0, 0.5, 0.05)],
    ["staticGateMinExecution", probabilities],
  ];
}

function numericRange(
  start: number,
  end: number,
  step: number,
): ReadonlyArray<number> {
  const values: Array<number> = [];
  for (let value = start; value <= end + step / 2; value += step) {
    values.push(Number(value.toFixed(4)));
  }
  return values;
}

function emptyDecisionMatrix(): Record<
  Decision,
  Record<Decision, number>
> {
  return {
    allow: { allow: 0, ask: 0, deny: 0 },
    ask: { allow: 0, ask: 0, deny: 0 },
    deny: { allow: 0, ask: 0, deny: 0 },
  };
}

function decisionLoss(expected: Decision, actual: Decision): number {
  if (expected === actual) return 0;
  if (expected === "deny") return actual === "allow" ? 20 : 4;
  if (expected === "ask") return actual === "allow" ? 5 : 2;
  return actual === "deny" ? 3 : 1;
}
