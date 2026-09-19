import { mkdir } from "node:fs/promises";
import { analyze } from "../src/analyze.ts";
import { judgeState } from "../src/guard.ts";
import { MISSING_KEY_HELP, resolveApiKey } from "../src/key.ts";
import type { CommandState } from "../src/types.ts";
import { SYNTHETIC_CASES } from "./cases.ts";
import {
  runSyntheticEval,
  type SyntheticEvalCase,
  type SyntheticEvalReport,
} from "./evaluate.ts";

const SYNTHETIC_CWD = "/workspace/synthetic-demur-project";
const SYNTHETIC_HOME = "/home/synthetic-user";
const OUTPUT_PATH = ".scratch/synthetic-eval.json";
const MAX_RUNS = 10;

const USAGE = `Usage: bun run eval:synthetic [--runs=N]

Sends synthetic command strings to TypeSafe and evaluates demur's judgments and
policy. Candidate commands are fixture data only and are never executed.

Options:
  --runs=N  Samples per case (default: 1, maximum: 10)
  --help    Show this help
`;

/**
 * Parse the requested number of model samples per synthetic case.
 *
 * @param args - Command-line options after the script name
 * @returns Positive number of samples per case
 */
export function parseRunCount(args: ReadonlyArray<string>): number {
  let runs = 1;
  for (const arg of args) {
    if (!arg.startsWith("--runs=")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = Number(arg.slice("--runs=".length));
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError("--runs must be a positive integer");
    }
    if (value > MAX_RUNS) {
      throw new RangeError(`--runs must be at most ${MAX_RUNS}`);
    }
    runs = value;
  }
  return runs;
}

/**
 * Build fixed synthetic state for one inert command fixture.
 *
 * The returned command is judged as data. This function performs only pure
 * analysis and does not launch a shell or any candidate executable.
 *
 * @param testCase - Synthetic contrast case
 * @param runIndex - Zero-based repeat index
 * @returns Complete state for demur's existing `judgeState` seam
 */
export function makeSyntheticState(
  testCase: SyntheticEvalCase,
  runIndex: number,
): CommandState {
  return {
    command: testCase.command,
    cwd: SYNTHETIC_CWD,
    agent: "cli",
    git: {
      root: SYNTHETIC_CWD,
      branch: "main",
      uncommittedFileCount: 0,
      untrackedFileCount: 0,
      unpushedCommitCount: 0,
      hasUpstream: true,
    },
    nonce: `${testCase.id}:${runIndex}:${crypto.randomUUID()}`,
    analysis: analyze(
      testCase.command,
      SYNTHETIC_CWD,
      SYNTHETIC_HOME,
      "/tmp",
    ),
  };
}

async function main(args: ReadonlyArray<string>): Promise<number> {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  const runs = parseRunCount(args);
  const resolvedKey = await resolveApiKey();
  if (resolvedKey === undefined) {
    console.error(MISSING_KEY_HELP);
    return 2;
  }

  console.log(
    `Judging ${SYNTHETIC_CASES.length} inert cases with ${runs} sample${runs === 1 ? "" : "s"} each. No candidate command will be executed.`,
  );

  const report = await runSyntheticEval(
    SYNTHETIC_CASES,
    (testCase, runIndex) =>
      judgeState(makeSyntheticState(testCase, runIndex)),
    runs,
  );

  await mkdir(".scratch", { recursive: true });
  await Bun.write(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  console.log(`\nDetailed JSON: ${OUTPUT_PATH}`);

  return report.failedCases === 0 ? 0 : 1;
}

function printReport(report: SyntheticEvalReport): void {
  for (const result of report.results) {
    const marker = result.passed ? "PASS" : "FAIL";
    const score = result.score?.toFixed(3) ?? "n/a";
    const flip = result.decisionFlipped ? " flip" : "";
    console.log(
      `${marker} ${result.testCase.id}: expected=${result.testCase.expected} actual=${result.classification} score=${score} policy=${result.decision ?? "n/a"}${flip}`,
    );
  }

  for (const signal of [
    "exposesSensitiveData",
    "weakensSecurityBoundary",
  ] as const) {
    const summary = report.bySignal[signal];
    console.log(
      `${signal}: ${summary.passedCases}/${summary.totalCases} passed (active ${summary.activePassed}/${summary.activeExpected}, inactive ${summary.inactivePassed}/${summary.inactiveExpected}, borderline ${summary.borderlineCases}, unavailable ${summary.unavailableCases})`,
    );
  }

  console.log(
    `\n${report.passedCases}/${report.totalCases} cases passed; ${report.decisionFlips} decision flips across ${report.totalSamples} samples.`,
  );
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
