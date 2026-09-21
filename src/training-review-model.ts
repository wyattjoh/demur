import type {
  TrainingRecord,
  TrainingReview,
  TrainingReviewInput,
} from "../extensions/demur/training-store.ts";
import type { Decision } from "./types.ts";

/**
 * Complete append-only training evidence and human review state.
 */
export type TrainingReviewSnapshot = {
  records: ReadonlyArray<TrainingRecord>;
  reviews: ReadonlyArray<TrainingReview>;
};

/**
 * One training record paired with every review appended for its stable ID.
 */
export type TrainingReviewEntry = {
  record: TrainingRecord;
  reviews: ReadonlyArray<TrainingReview>;
};

/**
 * Latest human-review status derived for one training entry.
 */
export type TrainingReviewStatus = "unreviewed" | Decision;

/**
 * Status tabs available in the interactive training-review queue.
 */
export type TrainingReviewFilter = "all" | TrainingReviewStatus;

/**
 * Pair each captured record with its append-only review history.
 *
 * @param snapshot - Complete record and review state
 * @returns Entries in capture order with reviews in append order
 */
export function buildTrainingReviewEntries(
  snapshot: TrainingReviewSnapshot,
): ReadonlyArray<TrainingReviewEntry> {
  const reviewsByRecord = new Map<string, Array<TrainingReview>>();
  for (const review of snapshot.reviews) {
    const reviews = reviewsByRecord.get(review.recordId) ?? [];
    reviews.push(review);
    reviewsByRecord.set(review.recordId, reviews);
  }

  return snapshot.records.map((record) => ({
    record,
    reviews: reviewsByRecord.get(record.id) ?? [],
  }));
}

/**
 * Return the latest append-only human review for an entry.
 *
 * @param entry - Training record and its review history
 * @returns Latest review, or undefined when the record is unreviewed
 */
export function getLatestTrainingReview(
  entry: TrainingReviewEntry,
): TrainingReview | undefined {
  return entry.reviews.at(-1);
}

/**
 * Classify an entry by its latest human answer.
 *
 * @param entry - Training record and its review history
 * @returns Unreviewed or the latest expected decision
 */
export function getTrainingReviewFilter(
  entry: TrainingReviewEntry,
): TrainingReviewStatus {
  return getLatestTrainingReview(entry)?.expectedDecision ?? "unreviewed";
}

/**
 * Select one status tab and fuzzy-search matching working directories.
 *
 * @param entries - Complete training history
 * @param filter - Active latest-answer status
 * @param cwdQuery - Optional fuzzy working-directory query
 * @returns Matching entries, ranked by path match when a query is present
 */
export function filterTrainingReviewEntries(
  entries: ReadonlyArray<TrainingReviewEntry>,
  filter: TrainingReviewFilter,
  cwdQuery: string,
): ReadonlyArray<TrainingReviewEntry> {
  const statusMatches = filter === "all"
    ? entries
    : entries.filter((entry) => getTrainingReviewFilter(entry) === filter);
  const query = cwdQuery.trim().toLowerCase();
  if (query === "") return statusMatches;

  return statusMatches
    .map((entry, index) => ({
      entry,
      index,
      score: fuzzyPathScore(entry.record.cwd, query),
    }))
    .filter(
      (candidate): candidate is {
        entry: TrainingReviewEntry;
        index: number;
        score: number;
      } => candidate.score !== undefined,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.entry);
}

/**
 * Build an append-only review revision from a human decision.
 *
 * @param record - Training evidence being reviewed
 * @param expectedDecision - Human-selected expected outcome
 * @param note - Optional correction explanation
 * @returns Normalized review input for persistence
 */
export function createTrainingReviewInput(
  record: TrainingRecord,
  expectedDecision: Decision,
  note: string | undefined,
): TrainingReviewInput {
  const corrected = expectedDecision !== record.verdict.decision;
  return {
    recordId: record.id,
    originalDecision: record.verdict.decision,
    expectedDecision,
    note: corrected ? note?.trim() || undefined : undefined,
  };
}

function fuzzyPathScore(path: string, query: string): number | undefined {
  const candidate = path.toLowerCase();
  const substringIndex = candidate.indexOf(query);
  if (substringIndex >= 0) {
    return 10_000 + segmentStartBonus(candidate, substringIndex) -
      substringIndex;
  }

  const positions: Array<number> = [];
  let candidateIndex = 0;
  for (const character of query) {
    const matchIndex = candidate.indexOf(character, candidateIndex);
    if (matchIndex < 0) return undefined;
    positions.push(matchIndex);
    candidateIndex = matchIndex + 1;
  }

  const first = positions[0];
  const last = positions.at(-1);
  if (first === undefined || last === undefined) return undefined;

  const span = last - first + 1;
  let consecutive = 0;
  let segmentStarts = 0;
  for (const [index, position] of positions.entries()) {
    if (index > 0 && position === positions[index - 1]! + 1) {
      consecutive += 1;
    }
    segmentStarts += segmentStartBonus(candidate, position);
  }

  return query.length * 100 - span * 4 - first + consecutive * 12 +
    segmentStarts;
}

function segmentStartBonus(path: string, index: number): number {
  return index === 0 || path[index - 1] === "/" ? 40 : 0;
}
