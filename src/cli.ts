#!/usr/bin/env bun
import { Predicate } from "effect";
import { loadCostTotals } from "../extensions/demur/cost-tracker.ts";
import {
  loadDemurSettings,
  saveDemurSettings,
  type DemurSettings,
} from "../extensions/demur/settings.ts";
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
  createTrainingReviewInput,
  filterTrainingReviewEntries,
  getLatestTrainingReview,
  getTrainingReviewFilter,
  type TrainingReviewEntry,
  type TrainingReviewFilter,
  type TrainingReviewSnapshot,
} from "./training-review-model.ts";
import type { TrainingReviewTuiResult } from "./training-review-tui.tsx";
import type { Verdict } from "./types.ts";

const USAGE = `Usage:
  demur
  demur auth login
  demur auth status
  demur auth logout
  demur training list [--status=<all|unreviewed|allow|ask|deny>] [--cwd=<query>] [--json]
  demur training review
  demur training review <record-id> --decision=<allow|ask|deny> [--note=<text>] [--json]
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
  loadDemurSettings(): Promise<DemurSettings>;
  saveDemurSettings(settings: DemurSettings): Promise<void>;
  runTrainingReviewTui(
    snapshot: TrainingReviewSnapshot,
    settings: DemurSettings,
    reloadSnapshot: () => Promise<TrainingReviewSnapshot>,
    recordReview: (input: TrainingReviewInput) => Promise<TrainingReview>,
    saveSettings: (settings: DemurSettings) => Promise<void>,
  ): Promise<TrainingReviewTuiResult>;
  isInteractive(): boolean;
  readSecret(prompt: string): Promise<string>;
  cwd(): string;
  stdout(message: string): void;
  stderr(message: string): void;
};

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
  loadDemurSettings,
  saveDemurSettings,
  runTrainingReviewTui: async (
    snapshot,
    settings,
    reloadSnapshot,
    recordReview,
    saveSettings,
  ) => {
    const { runTrainingReviewTui } = await import(
      "./training-review-tui.tsx"
    );
    return runTrainingReviewTui(
      snapshot,
      settings,
      reloadSnapshot,
      recordReview,
      saveSettings,
    );
  },
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readSecret,
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
          "demur: the interactive app requires a terminal; use `demur training list --json` or review a record by ID.",
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
    if (isTrainingJsonRequest(args)) {
      writeTrainingJsonError(
        trainingOperation(args),
        "unexpected_error",
        errorDetail(error),
        dependencies,
      );
    } else {
      dependencies.stderr(`demur: ${errorDetail(error)}`);
    }
    return 1;
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

type ParsedArguments = {
  positionals: ReadonlyArray<string>;
  options: ReadonlyMap<string, string | true>;
};

type ParseArgumentsResult =
  | { parsed: ParsedArguments; error: undefined }
  | { parsed: undefined; error: string };

async function runTraining(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  const command = args[0];
  if (command === "list") {
    return runTrainingList(args.slice(1), dependencies);
  }

  if (command === "review") {
    if (args.length === 1) {
      return runInteractiveTrainingReview(dependencies);
    }
    return runTrainingReview(args.slice(1), dependencies);
  }

  return writeTrainingUsageError(
    trainingOperation(["training", ...args]),
    args.includes("--json"),
    "expected `training list` or `training review`",
    dependencies,
  );
}

async function runInteractiveTrainingReview(
  dependencies: CliDependencies,
): Promise<number> {
  if (!dependencies.isInteractive()) {
    dependencies.stderr(
      "demur: `training review` requires a terminal; use `training list --json` and review a record by ID.",
    );
    return 2;
  }

  const loadSnapshot = () => loadTrainingReviewSnapshot(dependencies);
  const snapshot = await loadSnapshot();
  const settings = await dependencies.loadDemurSettings();
  const result = await dependencies.runTrainingReviewTui(
    snapshot,
    settings,
    loadSnapshot,
    dependencies.recordTrainingReview,
    dependencies.saveDemurSettings,
  );
  printReviewSummary(result, dependencies);
  return 0;
}

async function runTrainingList(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  const operation = "training.list";
  const parsedResult = parseArguments(
    args,
    new Set(["json"]),
    new Set(["status", "cwd"]),
  );
  const json = args.includes("--json");
  if (parsedResult.error !== undefined) {
    return writeTrainingUsageError(
      operation,
      json,
      parsedResult.error,
      dependencies,
    );
  }

  const parsed = parsedResult.parsed;
  if (parsed.positionals.length !== 0) {
    return writeTrainingUsageError(
      operation,
      hasOption(parsed, "json"),
      "`training list` does not accept positional arguments",
      dependencies,
    );
  }

  const statusValue = getStringOption(parsed, "status") ?? "all";
  if (!isTrainingReviewFilter(statusValue)) {
    return writeTrainingUsageError(
      operation,
      hasOption(parsed, "json"),
      `unsupported status: ${statusValue}`,
      dependencies,
    );
  }

  const cwdQuery = getStringOption(parsed, "cwd") ?? "";
  const entries = filterTrainingReviewEntries(
    await loadTrainingEntries(dependencies),
    statusValue,
    cwdQuery,
  );

  if (hasOption(parsed, "json")) {
    writeTrainingJsonSuccess(
      operation,
      {
        filter: {
          status: statusValue,
          cwd: cwdQuery === "" ? null : cwdQuery,
        },
        records: entries.map(trainingListRecord),
      },
      dependencies,
    );
    return 0;
  }

  if (entries.length === 0) {
    dependencies.stdout("No matching demur training records.");
    return 0;
  }

  dependencies.stdout(
    `${entries.length} matching training record${entries.length === 1 ? "" : "s"}:`,
  );
  for (const entry of entries) {
    const record = entry.record;
    dependencies.stdout(
      [
        record.id,
        getTrainingReviewFilter(entry),
        `model=${record.verdict.decision}`,
        record.cwd,
        summarizeTrainingCommand(record.command),
      ].join("\t"),
    );
  }
  return 0;
}

async function runTrainingReview(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  const operation = "training.review";
  const parsedResult = parseArguments(
    args,
    new Set(["json"]),
    new Set(["decision", "note"]),
  );
  const json = args.includes("--json");
  if (parsedResult.error !== undefined) {
    return writeTrainingUsageError(
      operation,
      json,
      parsedResult.error,
      dependencies,
    );
  }

  const parsed = parsedResult.parsed;
  if (parsed.positionals.length !== 1) {
    return writeTrainingUsageError(
      operation,
      hasOption(parsed, "json"),
      "`training review` requires exactly one record ID",
      dependencies,
    );
  }

  const decisionValue = getStringOption(parsed, "decision");
  if (decisionValue === undefined || !isDecision(decisionValue)) {
    return writeTrainingUsageError(
      operation,
      hasOption(parsed, "json"),
      "`--decision` must be allow, ask, or deny",
      dependencies,
    );
  }

  const recordId = parsed.positionals[0];
  const entries = await loadTrainingEntries(dependencies);
  const entry = entries.find((candidate) => candidate.record.id === recordId);
  if (entry === undefined) {
    return writeTrainingDomainError(
      operation,
      hasOption(parsed, "json"),
      "record_not_found",
      `training record not found: ${recordId}`,
      dependencies,
    );
  }

  const previousReview = getLatestTrainingReview(entry) ?? null;
  const review = await dependencies.recordTrainingReview(
    createTrainingReviewInput(
      entry.record,
      decisionValue,
      getStringOption(parsed, "note"),
    ),
  );
  const corrected = decisionValue !== entry.record.verdict.decision;

  if (hasOption(parsed, "json")) {
    writeTrainingJsonSuccess(
      operation,
      { review, corrected, previousReview },
      dependencies,
    );
    return 0;
  }

  dependencies.stdout(
    `Recorded ${decisionValue.toUpperCase()} review for ${recordId}${corrected ? ` (model: ${entry.record.verdict.decision.toUpperCase()})` : " (accepted model decision)"}.`,
  );
  return 0;
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

async function loadTrainingEntries(
  dependencies: CliDependencies,
): Promise<ReadonlyArray<TrainingReviewEntry>> {
  const [records, reviews] = await Promise.all([
    dependencies.loadTrainingRecords(),
    dependencies.loadTrainingReviews(),
  ]);
  return buildTrainingReviewEntries({
    records,
    reviews,
    globalEstimatedCostUsd: 0,
  });
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

function parseArguments(
  args: ReadonlyArray<string>,
  booleanOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): ParseArgumentsResult {
  const positionals: Array<string> = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator < 0 ? undefined : separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    if (options.has(name)) {
      return { parsed: undefined, error: `duplicate option: --${name}` };
    }

    if (booleanOptions.has(name)) {
      if (inlineValue !== undefined) {
        return {
          parsed: undefined,
          error: `option --${name} does not accept a value`,
        };
      }
      options.set(name, true);
      continue;
    }

    if (!valueOptions.has(name)) {
      return { parsed: undefined, error: `unknown option: --${name}` };
    }

    const followingValue = args[index + 1];
    const value = inlineValue ??
      (followingValue !== undefined && !followingValue.startsWith("--")
        ? followingValue
        : undefined);
    if (value === undefined) {
      return {
        parsed: undefined,
        error: `option --${name} requires a value`,
      };
    }
    if (inlineValue === undefined) index += 1;
    options.set(name, value);
  }

  return { parsed: { positionals, options }, error: undefined };
}

function getStringOption(
  parsed: ParsedArguments,
  name: string,
): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasOption(parsed: ParsedArguments, name: string): boolean {
  return parsed.options.has(name);
}

function isTrainingReviewFilter(value: string): value is TrainingReviewFilter {
  return value === "all" ||
    value === "unreviewed" ||
    value === "allow" ||
    value === "ask" ||
    value === "deny";
}

function isDecision(value: string): value is "allow" | "ask" | "deny" {
  return value === "allow" || value === "ask" || value === "deny";
}

function trainingListRecord(entry: TrainingReviewEntry): object {
  return {
    status: getTrainingReviewFilter(entry),
    record: entry.record,
    reviews: entry.reviews,
    latestReview: getLatestTrainingReview(entry) ?? null,
  };
}

function summarizeTrainingCommand(command: string): string {
  return command.replaceAll(/\s+/g, " ").trim();
}

function writeTrainingUsageError(
  operation: string,
  json: boolean,
  message: string,
  dependencies: CliDependencies,
): number {
  if (json) {
    writeTrainingJsonError(
      operation,
      "invalid_arguments",
      message,
      dependencies,
    );
  } else {
    dependencies.stderr(`demur: ${message}`);
    dependencies.stderr(USAGE);
  }
  return 2;
}

function writeTrainingDomainError(
  operation: string,
  json: boolean,
  code: string,
  message: string,
  dependencies: CliDependencies,
): number {
  if (json) {
    writeTrainingJsonError(operation, code, message, dependencies);
  } else {
    dependencies.stderr(`demur: ${message}`);
  }
  return 1;
}

function writeTrainingJsonSuccess(
  operation: string,
  result: unknown,
  dependencies: CliDependencies,
): void {
  dependencies.stdout(JSON.stringify({ version: 1, ok: true, operation, result }));
}

function writeTrainingJsonError(
  operation: string,
  code: string,
  message: string,
  dependencies: CliDependencies,
): void {
  dependencies.stdout(JSON.stringify({
    version: 1,
    ok: false,
    operation,
    error: { code, message },
  }));
}

function isTrainingJsonRequest(args: ReadonlyArray<string>): boolean {
  return args[0] === "training" && args.includes("--json");
}

function trainingOperation(args: ReadonlyArray<string>): string {
  return `training.${args[1] ?? "unknown"}`;
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
