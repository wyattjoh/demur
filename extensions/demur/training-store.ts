import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Decision, Verdict } from "../../src/types.ts";
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
 * Complete evidence captured for one training-mode command evaluation.
 */
export type TrainingRecord = {
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
 * Human review of one captured training evaluation.
 */
export type TrainingReview = {
  version: 1;
  recordId: string;
  reviewedAt: string;
  originalDecision: Decision;
  expectedDecision: Decision;
  note: string | undefined;
};

/**
 * Input required to append a human review.
 */
export type TrainingReviewInput = {
  recordId: string;
  originalDecision: Decision;
  expectedDecision: Decision;
  note: string | undefined;
};

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
  input: Omit<TrainingRecord, "version" | "id" | "recordedAt">,
  logPath: string = getTrainingLogPath(),
): Promise<TrainingRecord> {
  const record: TrainingRecord = {
    version: 1,
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
): Promise<TrainingReview> {
  const review: TrainingReview = {
    version: 1,
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
    record.version !== 1 ||
    typeof record.id !== "string" ||
    typeof record.recordedAt !== "string" ||
    typeof record.command !== "string" ||
    typeof record.cwd !== "string" ||
    (record.mode !== "enforce" && record.mode !== "passive") ||
    (record.hostAction !== "allow" && record.hostAction !== "block") ||
    !isVerdict(record.verdict)
  ) {
    throw invalidRecord(path, line);
  }

  const verdict = record.verdict as Record<string, unknown>;
  return {
    version: 1,
    id: record.id,
    recordedAt: record.recordedAt,
    command: record.command,
    cwd: record.cwd,
    mode: record.mode,
    verdict: {
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
    },
    hostAction: record.hostAction,
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
    review.version !== 1 ||
    typeof review.recordId !== "string" ||
    typeof review.reviewedAt !== "string" ||
    !isDecision(review.originalDecision) ||
    !isDecision(review.expectedDecision) ||
    (review.note !== undefined &&
      review.note !== null &&
      typeof review.note !== "string")
  ) {
    throw invalidRecord(path, line);
  }

  return {
    version: 1,
    recordId: review.recordId,
    reviewedAt: review.reviewedAt,
    originalDecision: review.originalDecision,
    expectedDecision: review.expectedDecision,
    note: review.note === null ? undefined : review.note,
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
