#!/usr/bin/env bun
import { guard } from "./guard.ts";

/**
 * Judge a single command from the terminal and print the verdict with the
 * judgments behind it.
 *
 * Usage: `bun run judge "git reset --hard"` — optionally with `--cwd=<path>`.
 */
async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const cwdArg = args.find((a) => a.startsWith("--cwd="));
  const command = args.filter((a) => !a.startsWith("--")).join(" ");

  if (command.trim() === "") {
    console.error('Usage: bun run judge "<command>" [--cwd=<path>]');
    process.exit(2);
  }

  const cwd = cwdArg?.slice("--cwd=".length) ?? process.cwd();
  const verdict = await guard(command, cwd, "cli");

  const mark = { allow: "✓", ask: "?", deny: "✗" }[verdict.decision];
  console.log(`${mark} ${verdict.decision.toUpperCase()}  ${verdict.reason}`);

  if (verdict.judgments !== undefined) {
    const j = verdict.judgments;
    console.log("");
    console.log(`  executes destruction    ${j.executesDestruction.toFixed(3)}`);
    console.log(`  unrecoverable           ${j.unrecoverable.toFixed(3)}`);
    console.log(`  shared infrastructure   ${j.targetsSharedInfrastructure.toFixed(3)}`);
    console.log(`  blast radius            ${j.blastRadius.toFixed(2)}/3  (confidence ${j.blastRadiusConfidence.toFixed(2)})`);
  }

  console.log("");
  console.log(
    `  ${verdict.latencyMs}ms${verdict.usage ? `, ${verdict.usage.inputTokens} in / ${verdict.usage.outputTokens} out tokens` : ""}`,
  );
}

await main();
