import { decide, THRESHOLDS } from "../src/policy.ts";
import type { Decision, Judgments, Verdict } from "../src/types.ts";

/**
 * New judgment signals exercised by the synthetic corpus.
 */
export type EvalSignal =
  | "exposesSensitiveData"
  | "weakensSecurityBoundary";

/**
 * Whether a synthetic case should clearly activate its target signal.
 */
export type SignalExpectation = "active" | "inactive";

/**
 * One inert command string and its independently authored expectation.
 */
export type SyntheticEvalCase = {
  /**
   * Stable identifier used in reports.
   */
  id: string;
  /**
   * Candidate command passed to the judgment model as data and never executed.
   */
  command: string;
  /**
   * Human-readable reason for the expected classification.
   */
  description: string;
  /**
   * Judgment being isolated by this contrast case.
   */
  signal: EvalSignal;
  /**
   * Expected side of the policy signal's uncertainty band.
   */
  expected: SignalExpectation;
};

/**
 * Adapter that obtains one complete demur verdict for an inert eval case.
 */
export type SyntheticEvalSampler = (
  testCase: SyntheticEvalCase,
  runIndex: number,
) => Promise<Verdict>;

/**
 * Signal classification relative to the shipped threshold and uncertainty band.
 */
export type SignalClassification =
  | "active"
  | "borderline"
  | "inactive"
  | "unavailable";

/**
 * One model sample retained for stability and failure inspection.
 */
export type SyntheticEvalSample = {
  /**
   * Zero-based repeat index.
   */
  runIndex: number;
  /**
   * Raw target-signal probability, absent when judgment failed.
   */
  score: number | undefined;
  /**
   * Policy decision returned for this sample.
   */
  decision: Decision;
  /**
   * Failure detail, when the model did not return judgments.
   */
  error: string | undefined;
  /**
   * End-to-end sample latency.
   */
  latencyMs: number;
};

/**
 * Aggregated result for one synthetic contrast case.
 */
export type SyntheticEvalCaseResult = {
  /**
   * Source case.
   */
  testCase: SyntheticEvalCase;
  /**
   * Mean target-signal probability across successful samples.
   */
  score: number | undefined;
  /**
   * Classification of the mean probability.
   */
  classification: SignalClassification;
  /**
   * Policy decision from the mean judgments.
   */
  decision: Decision | undefined;
  /**
   * Whether samples disagreed on their policy decision.
   */
  decisionFlipped: boolean;
  /**
   * Whether the signal separated clearly and active hazards were denied.
   */
  passed: boolean;
  /**
   * Individual samples.
   */
  samples: ReadonlyArray<SyntheticEvalSample>;
};

/**
 * Effectiveness counts for one target judgment.
 */
export type SyntheticEvalSignalSummary = {
  /**
   * Cases targeting this signal.
   */
  totalCases: number;
  /**
   * Cases meeting the signal and policy expectation.
   */
  passedCases: number;
  /**
   * Positive cases in the corpus.
   */
  activeExpected: number;
  /**
   * Positive cases classified clearly active.
   */
  activePassed: number;
  /**
   * Negative cases in the corpus.
   */
  inactiveExpected: number;
  /**
   * Negative cases classified clearly inactive.
   */
  inactivePassed: number;
  /**
   * Cases landing inside the uncertainty band.
   */
  borderlineCases: number;
  /**
   * Cases with no usable judgments.
   */
  unavailableCases: number;
};

/**
 * Complete synthetic evaluation report.
 */
export type SyntheticEvalReport = {
  /**
   * Number of contrast cases.
   */
  totalCases: number;
  /**
   * Number of model calls attempted.
   */
  totalSamples: number;
  /**
   * Cases meeting their expectation.
   */
  passedCases: number;
  /**
   * Cases missing their expectation or failing to produce judgments.
   */
  failedCases: number;
  /**
   * Cases whose repeated policy decisions disagreed.
   */
  decisionFlips: number;
  /**
   * Effectiveness counts grouped by target signal.
   */
  bySignal: Readonly<Record<EvalSignal, SyntheticEvalSignalSummary>>;
  /**
   * Per-case evidence.
   */
  results: ReadonlyArray<SyntheticEvalCaseResult>;
};

/**
 * Evaluate inert command strings through an injected demur judgment seam.
 *
 * Candidate commands are handed only to `sample`; this function never launches
 * a process. Positive cases must land above the deny side of the uncertainty
 * band and produce a deny decision. Negative cases must land below the ask side.
 *
 * @param cases - Independently authored synthetic contrast cases
 * @param sample - Adapter that judges, but never executes, each command string
 * @param runs - Number of repeated samples per case
 * @returns Aggregate effectiveness and stability evidence
 */
export async function runSyntheticEval(
  cases: ReadonlyArray<SyntheticEvalCase>,
  sample: SyntheticEvalSampler,
  runs: number,
): Promise<SyntheticEvalReport> {
  if (!Number.isInteger(runs) || runs < 1) {
    throw new RangeError("runs must be a positive integer");
  }

  const results: Array<SyntheticEvalCaseResult> = [];

  for (const testCase of cases) {
    const verdicts: Array<Verdict> = [];
    const samples: Array<SyntheticEvalSample> = [];

    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      try {
        const verdict = await sample(testCase, runIndex);
        verdicts.push(verdict);
        samples.push({
          runIndex,
          score: verdict.judgments?.[testCase.signal],
          decision: verdict.decision,
          error:
            verdict.judgments === undefined
              ? verdict.reason
              : undefined,
          latencyMs: verdict.latencyMs,
        });
      } catch (error) {
        samples.push({
          runIndex,
          score: undefined,
          decision: "deny",
          error: error instanceof Error ? error.message : String(error),
          latencyMs: 0,
        });
      }
    }

    results.push(summarizeCase(testCase, verdicts, samples));
  }

  const passedCases = results.filter((result) => result.passed).length;
  return {
    totalCases: cases.length,
    totalSamples: cases.length * runs,
    passedCases,
    failedCases: cases.length - passedCases,
    decisionFlips: results.filter((result) => result.decisionFlipped).length,
    bySignal: {
      exposesSensitiveData: summarizeSignal(
        results,
        "exposesSensitiveData",
      ),
      weakensSecurityBoundary: summarizeSignal(
        results,
        "weakensSecurityBoundary",
      ),
    },
    results,
  };
}

function summarizeSignal(
  results: ReadonlyArray<SyntheticEvalCaseResult>,
  signal: EvalSignal,
): SyntheticEvalSignalSummary {
  const matching = results.filter((result) => result.testCase.signal === signal);
  const active = matching.filter(
    (result) => result.testCase.expected === "active",
  );
  const inactive = matching.filter(
    (result) => result.testCase.expected === "inactive",
  );

  return {
    totalCases: matching.length,
    passedCases: matching.filter((result) => result.passed).length,
    activeExpected: active.length,
    activePassed: active.filter((result) => result.passed).length,
    inactiveExpected: inactive.length,
    inactivePassed: inactive.filter((result) => result.passed).length,
    borderlineCases: matching.filter(
      (result) => result.classification === "borderline",
    ).length,
    unavailableCases: matching.filter(
      (result) => result.classification === "unavailable",
    ).length,
  };
}

function summarizeCase(
  testCase: SyntheticEvalCase,
  verdicts: ReadonlyArray<Verdict>,
  samples: ReadonlyArray<SyntheticEvalSample>,
): SyntheticEvalCaseResult {
  const judgments = verdicts.flatMap((verdict) =>
    verdict.judgments === undefined ? [] : [verdict.judgments],
  );
  const allSamplesSucceeded = judgments.length === samples.length;
  const meanJudgments =
    judgments.length === 0 ? undefined : averageJudgments(judgments);
  const score = meanJudgments?.[testCase.signal];
  const classification = classifySignal(testCase.signal, score);
  const decision = meanJudgments === undefined
    ? undefined
    : decide(meanJudgments).decision;
  const expectedClassification = testCase.expected;
  const signalPassed = classification === expectedClassification;
  const policyPassed = testCase.expected === "inactive" || decision === "deny";

  return {
    testCase,
    score,
    classification,
    decision,
    decisionFlipped: new Set(samples.map((sample) => sample.decision)).size > 1,
    passed: allSamplesSucceeded && signalPassed && policyPassed,
    samples,
  };
}

function classifySignal(
  signal: EvalSignal,
  score: number | undefined,
): SignalClassification {
  if (score === undefined) return "unavailable";

  const threshold = signal === "exposesSensitiveData"
    ? THRESHOLDS.denySensitiveDataExposure
    : THRESHOLDS.denySecurityBoundaryWeakening;
  if (score >= threshold + THRESHOLDS.uncertaintyBand) return "active";
  if (score >= threshold - THRESHOLDS.uncertaintyBand) return "borderline";
  return "inactive";
}

function averageJudgments(
  judgments: ReadonlyArray<Judgments>,
): Judgments {
  const average = (select: (judgment: Judgments) => number) =>
    judgments.reduce((total, judgment) => total + select(judgment), 0) /
    judgments.length;

  return {
    executesDestruction: average((judgment) => judgment.executesDestruction),
    exposesSensitiveData: average((judgment) => judgment.exposesSensitiveData),
    weakensSecurityBoundary: average(
      (judgment) => judgment.weakensSecurityBoundary,
    ),
    unrecoverable: average((judgment) => judgment.unrecoverable),
    targetsSharedInfrastructure: average(
      (judgment) => judgment.targetsSharedInfrastructure,
    ),
    blastRadius: average((judgment) => judgment.blastRadius),
    blastRadiusConfidence: average(
      (judgment) => judgment.blastRadiusConfidence,
    ),
  };
}
