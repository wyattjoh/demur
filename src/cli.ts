#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Predicate } from "effect";
import { loadCostTotals } from "../extensions/demur/cost-tracker.ts";
import {
  loadTrainingRecords,
  loadTrainingReviews,
  recordTrainingReview,
  type TrainingRecord,
  type TrainingReview,
  type TrainingReviewInput,
} from "../extensions/demur/training-store.ts";
import { guard } from "./guard.ts";
import {
  deleteApiKey,
  resolveApiKey,
  storeApiKey,
  type ResolvedApiKey,
} from "./key.ts";
import {
  buildTrainingReviewEntries,
  getTrainingReviewFilter,
  type TrainingReviewSnapshot,
} from "./training-review-model.ts";
import type { TrainingReviewTuiResult } from "./training-review-tui.tsx";
import type { Verdict } from "./types.ts";

const USAGE = `Usage:
  demur
  demur auth login
  demur auth status
  demur auth logout
  demur training review [--plain]
  demur judge "<command>" [--cwd=<path>]`;

/**
 * Injectable process boundaries used by the command-line interface.
 */
export type CliDependencies = {
  judge(command: string, cwd: string): Promise<Verdict>;
  resolveApiKey(): Promise<ResolvedApiKey | undefined>;
  storeApiKey(value: string): Promise<void>;
  deleteApiKey(): Promise<boolean>;
  loadTrainingRecords(): Promise<ReadonlyArray<TrainingRecord>>;
  loadTrainingReviews(): Promise<ReadonlyArray<TrainingReview>>;
  loadGlobalEstimatedCostUsd(): Promise<number>;
  recordTrainingReview(input: TrainingReviewInput): Promise<TrainingReview>;
  runTrainingReviewTui(
    snapshot: TrainingReviewSnapshot,
    reloadSnapshot: () => Promise<TrainingReviewSnapshot>,
    recordReview: (input: TrainingReviewInput) => Promise<TrainingReview>,
  ): Promise<TrainingReviewTuiResult>;
  isInteractive(): boolean;
  readSecret(prompt: string): Promise<string>;
  readLine(prompt: string): Promise<string>;
  cwd(): string;
  stdout(message: string): void;
  stderr(message: string): void;
};

let lineInput:
  | {
    terminal: ReturnType<typeof createInterface>;
    lines: AsyncIterator<string>;
  }
  | undefined;

const defaultDependencies: CliDependencies = {
  judge: (command, cwd) => guard(command, cwd, "cli"),
  resolveApiKey,
  storeApiKey,
  deleteApiKey,
  loadTrainingRecords,
  loadTrainingReviews,
  loadGlobalEstimatedCostUsd: async () =>
    (await loadCostTotals()).estimatedCostUsd,
  recordTrainingReview,
  runTrainingReviewTui: async (snapshot, reloadSnapshot, recordReview) => {
    const { runTrainingReviewTui } = await import(
      "./training-review-tui.tsx"
    );
    return runTrainingReviewTui(snapshot, reloadSnapshot, recordReview);
  },
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readSecret,
  readLine,
  cwd: () => process.cwd(),
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

/**
 * Run demur's command-line interface with explicit process dependencies.
 *
 * @param args - Command-line arguments after the executable name
 * @param dependencies - Guard, credential, terminal, and process boundaries
 * @returns The process exit code
 */
export async function runCli(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  try {
    if (args.length === 0) {
      if (!dependencies.isInteractive()) {
        dependencies.stderr(
          "demur: the interactive app requires a terminal; use `demur training review --plain` for line-oriented review.",
        );
        return 2;
      }
      return await runTraining(["review"], dependencies);
    }

    if (args[0] === "auth") {
      return await runAuth(args.slice(1), dependencies);
    }

    if (args[0] === "training") {
      return await runTraining(args.slice(1), dependencies);
    }

    if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
      dependencies.stdout(USAGE);
      return 0;
    }

    const judgeArgs = args[0] === "judge" ? args.slice(1) : args;
    return await runJudge(judgeArgs, dependencies);
  } catch (error: unknown) {
    dependencies.stderr(`demur: ${errorDetail(error)}`);
    return 1;
  } finally {
    closeLineInput();
  }
}

async function runAuth(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  const command = args[0];

  if (command === "login" && args.length === 1) {
    const resolved = await dependencies.resolveApiKey();
    const value =
      resolved?.source === "environment"
        ? resolved.value
        : await dependencies.readSecret("TypeSafe API key: ");

    if (value.trim() === "") {
      dependencies.stderr("demur: the TypeSafe API key cannot be empty.");
      return 2;
    }

    await dependencies.storeApiKey(value);
    dependencies.stdout(
      resolved?.source === "environment"
        ? "Stored TYPESAFE_API_KEY in the operating system credential store."
        : "Stored the TypeSafe API key in the operating system credential store.",
    );
    if (resolved?.source === "environment") {
      dependencies.stdout(
        "TYPESAFE_API_KEY remains the active override until it is unset.",
      );
    }
    return 0;
  }

  if (command === "status" && args.length === 1) {
    const resolved = await dependencies.resolveApiKey();
    if (resolved === undefined) {
      dependencies.stderr("No TypeSafe API key is configured.");
      return 1;
    }

    dependencies.stdout(
      resolved.source === "environment"
        ? "A TypeSafe API key is configured through TYPESAFE_API_KEY."
        : "A TypeSafe API key is stored in the operating system credential store.",
    );
    return 0;
  }

  if (command === "logout" && args.length === 1) {
    const resolved = await dependencies.resolveApiKey();
    const deleted = await dependencies.deleteApiKey();
    dependencies.stdout(
      deleted
        ? "Deleted the stored TypeSafe API key."
        : "No stored TypeSafe API key was found.",
    );
    if (resolved?.source === "environment") {
      dependencies.stdout(
        "TYPESAFE_API_KEY remains configured and must be unset separately.",
      );
    }
    return 0;
  }

  dependencies.stderr(USAGE);
  return 2;
}

async function runTraining(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  const plain = args.includes("--plain");
  const operands = args.filter((arg) => arg !== "--plain");
  if (
    operands.length !== 1 ||
    operands[0] !== "review" ||
    args.filter((arg) => arg === "--plain").length > 1
  ) {
    dependencies.stderr(USAGE);
    return 2;
  }

  const loadSnapshot = () => loadTrainingReviewSnapshot(dependencies);
  const snapshot = await loadSnapshot();

  if (!plain && dependencies.isInteractive()) {
    const result = await dependencies.runTrainingReviewTui(
      snapshot,
      loadSnapshot,
      dependencies.recordTrainingReview,
    );
    printReviewSummary(result, dependencies);
    return 0;
  }

  const pending = buildTrainingReviewEntries(snapshot)
    .filter((entry) => getTrainingReviewFilter(entry) === "unreviewed")
    .map((entry) => entry.record);
  if (pending.length === 0) {
    dependencies.stdout("No unreviewed demur training records.");
    return 0;
  }

  return runPlainTrainingReview(pending, dependencies);
}

async function loadTrainingReviewSnapshot(
  dependencies: CliDependencies,
): Promise<TrainingReviewSnapshot> {
  const [records, reviews, globalEstimatedCostUsd] = await Promise.all([
    dependencies.loadTrainingRecords(),
    dependencies.loadTrainingReviews(),
    dependencies.loadGlobalEstimatedCostUsd(),
  ]);
  return { records, reviews, globalEstimatedCostUsd };
}

async function runPlainTrainingReview(
  pending: ReadonlyArray<TrainingRecord>,
  dependencies: CliDependencies,
): Promise<number> {
  let reviewed = 0;
  let corrected = 0;
  let skipped = 0;
  for (const [index, record] of pending.entries()) {
    printTrainingRecord(record, index + 1, pending.length, dependencies);
    const expectedDecision = await readExpectedDecision(record, dependencies);
    if (expectedDecision === "quit") break;
    if (expectedDecision === "skip") {
      skipped += 1;
      continue;
    }

    const isCorrection = expectedDecision !== record.verdict.decision;
    const note = isCorrection
      ? (await dependencies.readLine("Correction note (optional): ")).trim() ||
        undefined
      : undefined;
    await dependencies.recordTrainingReview({
      recordId: record.id,
      originalDecision: record.verdict.decision,
      expectedDecision,
      note,
    });
    reviewed += 1;
    if (isCorrection) corrected += 1;
    dependencies.stdout(
      isCorrection
        ? `Recorded correction: ${record.verdict.decision} → ${expectedDecision}.`
        : `Accepted ${record.verdict.decision} decision.`,
    );
  }

  printReviewSummary({ reviewed, corrected, skipped }, dependencies);
  return 0;
}

function printReviewSummary(
  result: TrainingReviewTuiResult,
  dependencies: CliDependencies,
): void {
  const skipped = result.skipped === 0
    ? "."
    : `; ${result.skipped} skipped.`;
  dependencies.stdout(
    `Reviewed ${result.reviewed} record${result.reviewed === 1 ? "" : "s"}; ${result.corrected} corrected${skipped}`,
  );
}

async function readExpectedDecision(
  record: TrainingRecord,
  dependencies: CliDependencies,
): Promise<"allow" | "ask" | "deny" | "skip" | "quit"> {
  while (true) {
    const input = (
      await dependencies.readLine(
        `Expected decision [enter=${record.verdict.decision}, allow, ask, deny, skip, quit]: `,
      )
    ).trim().toLowerCase();

    if (input === "") return record.verdict.decision;
    if (
      input === "allow" ||
      input === "ask" ||
      input === "deny" ||
      input === "skip" ||
      input === "quit"
    ) {
      return input;
    }
    dependencies.stderr(`Unknown review choice: ${input}`);
  }
}

function printTrainingRecord(
  record: TrainingRecord,
  index: number,
  total: number,
  dependencies: CliDependencies,
): void {
  dependencies.stdout("");
  dependencies.stdout(
    `[${index}/${total}] ${record.recordedAt} · ${record.mode} · host ${record.hostAction}`,
  );
  dependencies.stdout(`cwd: ${record.cwd}`);
  dependencies.stdout(`command: ${record.command}`);
  dependencies.stdout(
    `verdict: ${record.verdict.decision.toUpperCase()} — ${record.verdict.reason}`,
  );
  if (record.verdict.judgments !== undefined) {
    dependencies.stdout(
      `judgments: ${JSON.stringify(record.verdict.judgments)}`,
    );
  }
  if (record.verdict.failure !== undefined) {
    dependencies.stdout(`failure: ${record.verdict.failure}`);
  }
}

async function runJudge(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  const cwdArg = args.find((arg) => arg.startsWith("--cwd="));
  const command = args.filter((arg) => !arg.startsWith("--")).join(" ");

  if (command.trim() === "") {
    dependencies.stderr(USAGE);
    return 2;
  }

  const cwd = cwdArg?.slice("--cwd=".length) || dependencies.cwd();
  const verdict = await dependencies.judge(command, cwd);

  const mark = { allow: "✓", ask: "?", deny: "✗" }[verdict.decision];
  dependencies.stdout(
    `${mark} ${verdict.decision.toUpperCase()}  ${verdict.reason}`,
  );

  if (verdict.judgments !== undefined) {
    const judgments = verdict.judgments;
    dependencies.stdout("");
    dependencies.stdout(
      `  executes destruction    ${judgments.executesDestruction.toFixed(3)}`,
    );
    dependencies.stdout(
      `  sensitive-data exposure ${judgments.exposesSensitiveData.toFixed(3)}`,
    );
    dependencies.stdout(
      `  weakens security        ${judgments.weakensSecurityBoundary.toFixed(3)}`,
    );
    dependencies.stdout(
      `  unrecoverable           ${judgments.unrecoverable.toFixed(3)}`,
    );
    dependencies.stdout(
      `  shared infrastructure   ${judgments.targetsSharedInfrastructure.toFixed(3)}`,
    );
    dependencies.stdout(
      `  blast radius            ${judgments.blastRadius.toFixed(2)}/3  (confidence ${judgments.blastRadiusConfidence.toFixed(2)})`,
    );
  }

  dependencies.stdout("");
  dependencies.stdout(
    `  ${verdict.latencyMs}ms${verdict.usage ? `, ${verdict.usage.inputTokens} in / ${verdict.usage.outputTokens} out tokens` : ""}`,
  );
  return 0;
}

async function readLine(prompt: string): Promise<string> {
  if (lineInput === undefined) {
    const terminal = createInterface({ input: process.stdin });
    lineInput = {
      terminal,
      lines: terminal[Symbol.asyncIterator](),
    };
  }

  process.stderr.write(prompt);
  const next = await lineInput.lines.next();
  if (next.done) throw new Error("training review input ended");
  return next.value;
}

function closeLineInput(): void {
  lineInput?.terminal.close();
  lineInput = undefined;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return (await Bun.stdin.text()).trim();
  }

  process.stderr.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };

    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\u0003" || character === "\u0004") {
          cleanup();
          reject(new Error("credential entry cancelled"));
          return;
        }

        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }

        if (character === "\b" || character === "\u007f") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }

        if (character >= " ") value += character;
      }
    };

    process.stdin.on("data", onData);
  });
}

function errorDetail(error: unknown): string {
  return Predicate.isError(error) ? error.message : String(error);
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
