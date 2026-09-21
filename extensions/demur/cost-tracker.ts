import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDemurStateDirectory } from "./paths.ts";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * TypeSafe's published Jev input price in US dollars per million tokens.
 *
 * Source: https://typesafe.ai/blog/introducing-system-one-models-and-jev
 */
export const JEV_INPUT_COST_USD_PER_MILLION = 0.042;

/**
 * Persisted global usage and estimated-cost totals.
 */
export type CostTotals = {
  version: 1;
  totalInputTokens: number;
  estimatedCostUsd: number;
  updatedAt: string;
};

/**
 * Resolve the global demur usage file using demur-specific and XDG conventions.
 *
 * @param environment - Process environment used to resolve demur and XDG overrides
 * @param homeDirectory - Home directory used when the XDG override is absent
 * @returns Absolute path to demur's usage state file
 */
export function getCostStatePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(
    getDemurStateDirectory(environment, homeDirectory),
    "usage.json",
  );
}

/**
 * Estimate the Jev input cost from TypeSafe's published per-token price.
 *
 * This is a display estimate rather than an authoritative billing amount.
 *
 * @param inputTokens - Number of input tokens submitted to Jev
 * @returns Estimated cost in US dollars
 */
export function estimateInputCostUsd(inputTokens: number): number {
  return (inputTokens * JEV_INPUT_COST_USD_PER_MILLION) / 1_000_000;
}

/**
 * Atomically add one judgment's usage to the global accumulated estimate.
 *
 * A lock directory serializes read-modify-write operations across Pi processes.
 * The updated JSON is written to a same-directory temporary file and atomically
 * renamed over the previous state so readers never observe partial content.
 *
 * @param inputTokens - Number of input tokens submitted for this judgment
 * @param statePath - Usage file to update
 * @returns Updated accumulated totals
 */
export async function recordInputCost(
  inputTokens: number,
  statePath: string = getCostStatePath(),
): Promise<CostTotals> {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new Error("input token count must be a non-negative safe integer");
  }

  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${statePath}.lock`);

  try {
    const current = await readTotals(statePath);
    const next: CostTotals = {
      version: 1,
      totalInputTokens: current.totalInputTokens + inputTokens,
      estimatedCostUsd:
        current.estimatedCostUsd + estimateInputCostUsd(inputTokens),
      updatedAt: new Date().toISOString(),
    };
    await replaceJsonAtomically(statePath, next);
    return next;
  } finally {
    await release();
  }
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
        throw new Error(`timed out waiting for cost state lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function readTotals(statePath: string): Promise<CostTotals> {
  let content: string;
  try {
    content = await readFile(statePath, "utf8");
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) {
      return {
        version: 1,
        totalInputTokens: 0,
        estimatedCostUsd: 0,
        updatedAt: new Date(0).toISOString(),
      };
    }
    throw error;
  }

  const value: unknown = JSON.parse(content);
  if (value === null || typeof value !== "object") {
    throw new Error(`invalid cost state in ${statePath}: expected an object`);
  }

  const { version, totalInputTokens, estimatedCostUsd, updatedAt } =
    value as Record<string, unknown>;
  if (
    version !== 1 ||
    !Number.isSafeInteger(totalInputTokens) ||
    (totalInputTokens as number) < 0 ||
    typeof estimatedCostUsd !== "number" ||
    !Number.isFinite(estimatedCostUsd) ||
    estimatedCostUsd < 0 ||
    typeof updatedAt !== "string"
  ) {
    throw new Error(`invalid cost state in ${statePath}: unsupported values`);
  }

  return value as CostTotals;
}

async function replaceJsonAtomically(
  statePath: string,
  totals: CostTotals,
): Promise<void> {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(totals, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error: unknown) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
