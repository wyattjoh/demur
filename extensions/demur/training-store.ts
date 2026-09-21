import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Decision,
  GuardEvidence,
  Verdict,
} from "../../src/types.ts";
import { getDemurStateDirectory } from "./paths.ts";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Guard modes that can emit training records.
 */
export type TrainingMode = "enforce" | "passive";

/**
 * Action the Pi host took after demur evaluated a command.
 */
export type TrainingHostAction = "allow" | "block";

/**
 * Legacy training record captured before replayable invocation evidence existed.
 */
export type TrainingRecordV1 = {
  version: 1;
  id: string;
  recordedAt: string;
  command: string;
  cwd: string;
  mode: TrainingMode;
  verdict: Verdict;
  hostAction: TrainingHostAction;
};

/**
 * Training record with exact model state and policy provenance.
 */
export type TrainingRecordV2 = {
  version: 2;
  id: string;
  recordedAt: string;
  command: string;
  cwd: string;
  mode: TrainingMode;
  verdict: Verdict;
  evidence: GuardEvidence | undefined;
  hostAction: TrainingHostAction;
};

/**
 * Complete evidence captured for one training-mode command evaluation.
 */
export type TrainingRecord = TrainingRecordV1 | TrainingRecordV2;

/**
 * Machine-readable explanation for why a human corrected a verdict.
 */
export type TrainingCorrectionReason =
  | "inert-or-read-only"
  | "sensitive-data"
  | "security-boundary"
  | "recoverability"
  | "shared-infrastructure"
  | "blast-radius"
  | "static-uncertainty"
  | "missing-context"
  | "service-failure";

/**
 * Stable correction-reason values accepted by storage and CLI boundaries.
 */
export const TRAINING_CORRECTION_REASONS: ReadonlyArray<
  TrainingCorrectionReason
> = [
  "inert-or-read-only",
  "sensitive-data",
  "security-boundary",
  "recoverability",
  "shared-infrastructure",
  "blast-radius",
  "static-uncertainty",
  "missing-context",
  "service-failure",
];

/**
 * Legacy human review recorded before structured correction reasons existed.
 */
export type TrainingReviewV1 = {
  version: 1;
  recordId: string;
  reviewedAt: string;
  originalDecision: Decision;
  expectedDecision: Decision;
  note: string | undefined;
};

/**
 * Human review with a structured reason for corrected model decisions.
 */
export type TrainingReviewV2 = {
  version: 2;
  recordId: string;
  reviewedAt: string;
  originalDecision: Decision;
  expectedDecision: Decision;
  correctionReason: TrainingCorrectionReason | undefined;
  note: string | undefined;
};

/**
 * Human review of one captured training evaluation.
 */
export type TrainingReview = TrainingReviewV1 | TrainingReviewV2;

/**
 * Input required to append a human review.
 */
export type TrainingReviewInput = {
  recordId: string;
  originalDecision: Decision;
  expectedDecision: Decision;
  correctionReason: TrainingCorrectionReason | undefined;
  note: string | undefined;
};

/**
 * Input required to append a replayable training evaluation.
 */
export type TrainingRecordInput = Omit<
  TrainingRecordV2,
  "version" | "id" | "recordedAt"
>;

/**
 * Resolve the global training-record file according to demur and XDG overrides.
 *
 * @param environment - Process environment used to resolve demur and XDG overrides
 * @param homeDirectory - Home directory used when the XDG override is absent
 * @returns Absolute path to the append-only training JSONL file
 */
export function getTrainingLogPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(
    getDemurStateDirectory(environment, homeDirectory),
    "training.jsonl",
  );
}

/**
 * Resolve the global training-review file according to demur and XDG overrides.
 *
 * @param environment - Process environment used to resolve demur and XDG overrides
 * @param homeDirectory - Home directory used when the XDG override is absent
 * @returns Absolute path to the append-only review JSONL file
 */
export function getTrainingReviewPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(
    getDemurStateDirectory(environment, homeDirectory),
    "training-reviews.jsonl",
  );
}

/**
 * Append one complete command evaluation to the global training log.
 *
 * @param input - Evaluation evidence captured by the Pi extension
 * @param logPath - Training file to append
 * @returns The persisted record with generated identity and timestamp
 */
export async function recordTrainingEvaluation(
  input: TrainingRecordInput,
  logPath: string = getTrainingLogPath(),
): Promise<TrainingRecordV2> {
  const record: TrainingRecordV2 = {
    version: 2,
    id: randomUUID(),
    recordedAt: new Date().toISOString(),
    ...input,
  };
  await appendJsonLine(logPath, record);
  return record;
}

/**
 * Load and validate all captured training evaluations.
 *
 * @param logPath - Training file to read
 * @returns Valid training records in capture order
 */
export async function loadTrainingRecords(
  logPath: string = getTrainingLogPath(),
): Promise<ReadonlyArray<TrainingRecord>> {
  return readJsonLines(logPath, parseTrainingRecord);
}

/**
 * Append a human decision review to the global review log.
 *
 * @param input - Reviewed record identity, expected decision, and optional note
 * @param reviewPath - Review file to append
 * @returns The persisted review with its generated timestamp
 */
export async function recordTrainingReview(
  input: TrainingReviewInput,
  reviewPath: string = getTrainingReviewPath(),
): Promise<TrainingReviewV2> {
  if (
    input.originalDecision !== input.expectedDecision &&
    input.correctionReason === undefined
  ) {
    throw new Error("corrected training reviews require a correction reason");
  }
  if (
    input.originalDecision === input.expectedDecision &&
    input.correctionReason !== undefined
  ) {
    throw new Error("accepted training reviews cannot have a correction reason");
  }

  const review: TrainingReviewV2 = {
    version: 2,
    reviewedAt: new Date().toISOString(),
    ...input,
  };
  await appendJsonLine(reviewPath, review);
  return review;
}

/**
 * Load and validate all human training reviews.
 *
 * @param reviewPath - Review file to read
 * @returns Valid reviews in capture order
 */
export async function loadTrainingReviews(
  reviewPath: string = getTrainingReviewPath(),
): Promise<ReadonlyArray<TrainingReview>> {
  return readJsonLines(reviewPath, parseTrainingReview);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${path}.lock`);

  try {
    const line = JSON.stringify(
      value,
      (_key, nestedValue: unknown) =>
        nestedValue === undefined ? null : nestedValue,
    );
    await appendFile(path, `${line}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
  } finally {
    await release();
  }
}

async function readJsonLines<T>(
  path: string,
  parse: (value: unknown, path: string, line: number) => T,
): Promise<ReadonlyArray<T>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error: unknown) {
        throw new Error(
          `invalid JSONL in ${path} at line ${index + 1}: ${errorDetail(error)}`,
        );
      }
      return parse(value, path, index + 1);
    });
}

function parseTrainingRecord(
  value: unknown,
  path: string,
  line: number,
): TrainingRecord {
  if (value === null || typeof value !== "object") {
    throw invalidRecord(path, line);
  }

  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    typeof record.id !== "string" ||
    typeof record.recordedAt !== "string" ||
    typeof record.command !== "string" ||
    typeof record.cwd !== "string" ||
    (record.mode !== "enforce" && record.mode !== "passive") ||
    (record.hostAction !== "allow" && record.hostAction !== "block") ||
    !isVerdict(record.verdict) ||
    (record.version === 2 && !isGuardEvidence(record.evidence))
  ) {
    throw invalidRecord(path, line);
  }

  const verdict = normalizeVerdict(record.verdict);
  const common = {
    id: record.id,
    recordedAt: record.recordedAt,
    command: record.command,
    cwd: record.cwd,
    mode: record.mode,
    verdict,
    hostAction: record.hostAction,
  } as const;

  if (record.version === 1) return { version: 1, ...common };
  return {
    version: 2,
    ...common,
    evidence: record.evidence === null
      ? undefined
      : normalizeGuardEvidence(record.evidence),
  };
}

function parseTrainingReview(
  value: unknown,
  path: string,
  line: number,
): TrainingReview {
  if (value === null || typeof value !== "object") {
    throw invalidRecord(path, line);
  }

  const review = value as Record<string, unknown>;
  if (
    (review.version !== 1 && review.version !== 2) ||
    typeof review.recordId !== "string" ||
    typeof review.reviewedAt !== "string" ||
    !isDecision(review.originalDecision) ||
    !isDecision(review.expectedDecision) ||
    (review.note !== undefined &&
      review.note !== null &&
      typeof review.note !== "string") ||
    (review.version === 2 &&
      (!isReviewCorrectionReasonValid(review) ||
        (review.correctionReason !== undefined &&
          review.correctionReason !== null &&
          !isTrainingCorrectionReason(review.correctionReason))))
  ) {
    throw invalidRecord(path, line);
  }

  const common = {
    recordId: review.recordId,
    reviewedAt: review.reviewedAt,
    originalDecision: review.originalDecision,
    expectedDecision: review.expectedDecision,
    note: review.note === null ? undefined : review.note,
  } as const;
  if (review.version === 1) return { version: 1, ...common };
  return {
    version: 2,
    ...common,
    correctionReason: review.correctionReason === null
      ? undefined
      : review.correctionReason as TrainingCorrectionReason | undefined,
  };
}

function normalizeVerdict(value: unknown): Verdict {
  const verdict = value as Record<string, unknown>;
  return {
    decision: verdict.decision as Decision,
    reason: verdict.reason as string,
    judgments: verdict.judgments === null
      ? undefined
      : verdict.judgments as Verdict["judgments"],
    failure: verdict.failure === null
      ? undefined
      : verdict.failure as Verdict["failure"],
    latencyMs: verdict.latencyMs as number,
    usage: verdict.usage === null
      ? undefined
      : verdict.usage as Verdict["usage"],
  };
}

function isVerdict(value: unknown): value is Verdict {
  if (value === null || typeof value !== "object") return false;
  const verdict = value as Record<string, unknown>;
  return isDecision(verdict.decision) &&
    typeof verdict.reason === "string" &&
    typeof verdict.latencyMs === "number";
}

function isDecision(value: unknown): value is Decision {
  return value === "allow" || value === "ask" || value === "deny";
}

function isReviewCorrectionReasonValid(
  review: Record<string, unknown>,
): boolean {
  const corrected = review.originalDecision !== review.expectedDecision;
  const hasReason = review.correctionReason !== undefined &&
    review.correctionReason !== null;
  return corrected === hasReason;
}

/**
 * Check whether a value is a supported structured correction reason.
 *
 * @param value - Candidate correction-reason value
 * @returns Whether the value belongs to the stable correction taxonomy
 */
export function isTrainingCorrectionReason(
  value: unknown,
): value is TrainingCorrectionReason {
  return typeof value === "string" &&
    TRAINING_CORRECTION_REASONS.includes(value as TrainingCorrectionReason);
}

function isGuardEvidence(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  return evidence.modelState !== null &&
    typeof evidence.modelState === "object" &&
    (evidence.analysis === null || evidence.analysis === undefined ||
      typeof evidence.analysis === "object") &&
    typeof evidence.model === "string" &&
    Number.isInteger(evidence.questionSetVersion) &&
    Number.isInteger(evidence.policyVersion) &&
    isNumberRecord(evidence.policyThresholds);
}

function normalizeGuardEvidence(value: unknown): GuardEvidence {
  const evidence = value as Record<string, unknown>;
  return {
    modelState: evidence.modelState as GuardEvidence["modelState"],
    analysis: evidence.analysis === null
      ? undefined
      : evidence.analysis as GuardEvidence["analysis"],
    model: evidence.model as string,
    questionSetVersion: evidence.questionSetVersion as number,
    policyVersion: evidence.policyVersion as number,
    policyThresholds: evidence.policyThresholds as GuardEvidence["policyThresholds"],
  };
}

function isNumberRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).every((entry) =>
    typeof entry === "number" && Number.isFinite(entry)
  );
}

function invalidRecord(path: string, line: number): Error {
  return new Error(`invalid training record in ${path} at line ${line}`);
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        await rmdir(lockPath);
      };
    } catch (error: unknown) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for training state lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
