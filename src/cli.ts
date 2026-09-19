#!/usr/bin/env bun
import { Predicate } from "effect";
import { guard } from "./guard.ts";
import {
  deleteApiKey,
  resolveApiKey,
  storeApiKey,
  type ResolvedApiKey,
} from "./key.ts";
import type { Verdict } from "./types.ts";

const USAGE = `Usage:
  demur auth login
  demur auth status
  demur auth logout
  demur judge "<command>" [--cwd=<path>]`;

/**
 * Injectable process boundaries used by the command-line interface.
 */
export type CliDependencies = {
  judge(command: string, cwd: string): Promise<Verdict>;
  resolveApiKey(): Promise<ResolvedApiKey | undefined>;
  storeApiKey(value: string): Promise<void>;
  deleteApiKey(): Promise<boolean>;
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
    if (args[0] === "auth") {
      return await runAuth(args.slice(1), dependencies);
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
