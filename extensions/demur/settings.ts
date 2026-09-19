import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
   * Whether Bash calls are routed through demur.
   */
  enabled: boolean;
  /**
   * Host action to take when demur cannot obtain a trustworthy judgment.
   */
  failurePolicy: FailurePolicy;
};

/**
 * Safe settings used when no persisted Pi configuration exists.
 */
export const DEFAULT_DEMUR_SETTINGS: DemurSettings = {
  enabled: true,
  failurePolicy: "block",
};

type DemurConfig = DemurSettings & {
  version: 1;
};

/**
 * Resolve the global demur configuration file according to the XDG config
 * convention.
 *
 * @param environment - Process environment used to resolve `XDG_CONFIG_HOME`
 * @param homeDirectory - Home directory used when the XDG override is absent
 * @returns Absolute path to demur's global configuration file
 */
export function getDemurConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const configDirectory =
    environment.XDG_CONFIG_HOME || join(homeDirectory, ".config");
  return join(configDirectory, "demur", "config.json");
}

/**
 * Load the globally persisted Pi settings.
 *
 * A missing file uses the enabled, fail-closed defaults. Version 1 files from
 * before the enabled toggle omit that field and are treated as enabled.
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

  const { version, enabled, failurePolicy } = value as Record<string, unknown>;
  if (
    version !== 1 ||
    (enabled !== undefined && typeof enabled !== "boolean") ||
    !isFailurePolicy(failurePolicy)
  ) {
    throw new Error(`invalid demur config in ${configPath}: unsupported values`);
  }

  return {
    enabled: enabled ?? true,
    failurePolicy,
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
  const config: DemurConfig = { version: 1, ...settings };
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
 * Parse a command argument as a Pi failure policy.
 *
 * @param value - Raw slash-command argument
 * @returns Normalized policy, or `undefined` when the argument is invalid
 */
export function parseFailurePolicy(value: string): FailurePolicy | undefined {
  const normalized = value.trim().toLowerCase();
  return isFailurePolicy(normalized) ? normalized : undefined;
}

function isFailurePolicy(value: unknown): value is FailurePolicy {
  return FAILURE_POLICIES.some((policy) => policy === value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
