#!/usr/bin/env bun
import { Option, Schema } from "effect";
import { guard } from "../guard.ts";

const PreToolUsePayload = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(
    Schema.Struct({ command: Schema.optionalKey(Schema.String) }),
  ),
});

const decodePayload = Schema.decodeUnknownOption(PreToolUsePayload);

/**
 * Emit a `PreToolUse` decision on stdout in Claude Code's hook protocol.
 *
 * The hook always exits 0: the decision is carried by the JSON body, not the
 * exit code, and a non-zero exit would be read as a hook malfunction rather
 * than a policy result.
 *
 * @param decision - What Claude Code should do with the tool call
 * @param reason - Text shown to the model and the user
 */
function emit(decision: "allow" | "deny" | "ask", reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

/**
 * Read the hook payload, judge the command, and print the decision.
 *
 * Only `Bash` tool calls are judged; everything else is passed through
 * untouched so the hook can be registered broadly without cost.
 */
async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    // A malformed envelope is a guard failure, and demur fails closed.
    emit("deny", "demur: could not parse the PreToolUse payload.");
    return;
  }

  const payload = Option.getOrUndefined(decodePayload(input));
  if (payload === undefined) {
    emit("deny", "demur: invalid PreToolUse payload.");
    return;
  }

  if (payload.tool_name !== "Bash") {
    emit("allow", "demur: not a Bash call.");
    return;
  }

  const command = payload.tool_input?.command ?? "";
  const cwd = payload.cwd ?? process.cwd();
  const verdict = await guard(command, cwd, "claude-code");

  emit(verdict.decision, verdict.reason);
}

await main();
