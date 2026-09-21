import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDemurConfigDirectory } from "./paths.ts";

/**
 * How the Pi extension applies demur to Bash calls.
 */
export type DemurMode = "enforce" | "passive" | "disabled";

/**
 * Modes accepted by the Pi extension command.
 */
export const DEMUR_MODES: readonly DemurMode[] = [
  "enforce",
  "passive",
  "disabled",
];

/**
 * How the Pi extension handles guard failures that produce no trustworthy
 * policy judgment.
 */
export type FailurePolicy = "block" | "ask" | "allow";

/**
 * Failure policies accepted by the Pi extension command.
 */
export const FAILURE_POLICIES: readonly FailurePolicy[] = [
  "block",
  "ask",
  "allow",
];

/**
 * Globally persisted settings for the Pi extension.
 */
export type DemurSettings = {
  /**
   * Whether demur enforces, observes, or bypasses Bash calls.
   */
  mode: DemurMode;
  /**
   * Whether full command evaluations are appended to the training log.
   */
  training: boolean;
  /**
   * Host action to take when demur cannot obtain a trustworthy judgment.
   */
  failurePolicy: FailurePolicy;
};

/**
 * Safe settings used when no persisted Pi configuration exists.
 */
export const DEFAULT_DEMUR_SETTINGS: DemurSettings = {
  mode: "enforce",
  training: false,
  failurePolicy: "block",
};

type DemurConfig = DemurSettings & {
  version: 2;
};

/**
 * Resolve the global demur configuration file using demur-specific and XDG
 * directory conventions.
 *
 * @param environment - Process environment used to resolve demur and XDG overrides
 * @param homeDirectory - Home directory used when the XDG override is absent
 * @returns Absolute path to demur's global configuration file
 */
export function getDemurConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(
    getDemurConfigDirectory(environment, homeDirectory),
    "config.json",
  );
}

/**
 * Load the globally persisted Pi settings.
 *
 * A missing file uses the enforcing, fail-closed defaults. Version 1 files are
 * migrated from their former `enabled` boolean and start with training off.
 * Invalid or unreadable files are rejected so the extension can warn the user
 * while still falling back safely.
 *
 * @param configPath - Configuration file to read
 * @returns Persisted settings, or safe defaults when no file exists
 */
export async function loadDemurSettings(
  configPath: string = getDemurConfigPath(),
): Promise<DemurSettings> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) return { ...DEFAULT_DEMUR_SETTINGS };
    throw error;
  }

  const value: unknown = JSON.parse(content);
  if (value === null || typeof value !== "object") {
    throw new Error(`invalid demur config in ${configPath}: expected an object`);
  }

  const config = value as Record<string, unknown>;
  if (config.version === 1) {
    if (
      (config.enabled !== undefined && typeof config.enabled !== "boolean") ||
      !isFailurePolicy(config.failurePolicy)
    ) {
      throw new Error(`invalid demur config in ${configPath}: unsupported values`);
    }

    return {
      mode: config.enabled === false ? "disabled" : "enforce",
      training: false,
      failurePolicy: config.failurePolicy,
    };
  }

  if (
    config.version !== 2 ||
    !isDemurMode(config.mode) ||
    typeof config.training !== "boolean" ||
    (config.mode === "disabled" && config.training) ||
    !isFailurePolicy(config.failurePolicy)
  ) {
    throw new Error(`invalid demur config in ${configPath}: unsupported values`);
  }

  return {
    mode: config.mode,
    training: config.training,
    failurePolicy: config.failurePolicy,
  };
}

/**
 * Atomically persist the global Pi settings.
 *
 * @param settings - Settings to persist
 * @param configPath - Configuration file to replace
 */
export async function saveDemurSettings(
  settings: DemurSettings,
  configPath: string = getDemurConfigPath(),
): Promise<void> {
  if (settings.mode === "disabled" && settings.training) {
    throw new Error("training cannot be enabled while demur is disabled");
  }

  const config: DemurConfig = { version: 2, ...settings };
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error: unknown) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }
}

/**
 * Parse a command argument as a Pi operating mode.
 *
 * @param value - Raw slash-command argument
 * @returns Normalized mode, or `undefined` when the argument is invalid
 */
export function parseDemurMode(value: string): DemurMode | undefined {
  const normalized = value.trim().toLowerCase();
  return isDemurMode(normalized) ? normalized : undefined;
}

/**
 * Parse a command argument as a Pi failure policy.
 *
 * @param value - Raw slash-command argument
 * @returns Normalized policy, or `undefined` when the argument is invalid
 */
export function parseFailurePolicy(value: string): FailurePolicy | undefined {
  const normalized = value.trim().toLowerCase();
  return isFailurePolicy(normalized) ? normalized : undefined;
}

function isDemurMode(value: unknown): value is DemurMode {
  return DEMUR_MODES.some((mode) => mode === value);
}

function isFailurePolicy(value: unknown): value is FailurePolicy {
  return FAILURE_POLICIES.some((policy) => policy === value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
