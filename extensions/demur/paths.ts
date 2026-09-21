import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve demur's configuration directory.
 *
 * `DEMUR_CONFIG_HOME` takes precedence over the XDG config directory and the
 * standard home-directory fallback. Unlike `XDG_CONFIG_HOME`, the demur-specific
 * override names demur's directory directly.
 *
 * @param environment - Process environment used to resolve directory overrides
 * @param homeDirectory - Home directory used when overrides are absent
 * @returns Absolute or caller-provided path to demur's configuration directory
 */
export function getDemurConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  if (environment.DEMUR_CONFIG_HOME) return environment.DEMUR_CONFIG_HOME;

  const configHome = environment.XDG_CONFIG_HOME ||
    join(homeDirectory, ".config");
  return join(configHome, "demur");
}

/**
 * Resolve demur's persistent state directory.
 *
 * `DEMUR_STATE_HOME` takes precedence over the XDG state directory and the
 * standard home-directory fallback. Unlike `XDG_STATE_HOME`, the demur-specific
 * override names demur's directory directly.
 *
 * @param environment - Process environment used to resolve directory overrides
 * @param homeDirectory - Home directory used when overrides are absent
 * @returns Absolute or caller-provided path to demur's persistent state directory
 */
export function getDemurStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  if (environment.DEMUR_STATE_HOME) return environment.DEMUR_STATE_HOME;

  const stateHome = environment.XDG_STATE_HOME ||
    join(homeDirectory, ".local", "state");
  return join(stateHome, "demur");
}
