import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { guard } from "../../src/guard.ts";

/**
 * Handle one `tool_call` event, guarding shell commands only.
 *
 * Exported separately from the extension factory so it can be exercised
 * directly in tests without standing up a Pi runtime.
 *
 * @param event - The tool call Pi is about to execute
 * @param ctx - Extension context, used for the working directory and prompts
 * @returns A block result when the command is denied, otherwise nothing
 */
export async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
  if (!isToolCallEventType("bash", event)) return undefined;

  const command = event.input.command ?? "";
  if (command.trim() === "") return undefined;

  const verdict = await guard(command, ctx.cwd, "pi", ctx.signal);

  if (verdict.decision === "allow") return undefined;

  if (verdict.decision === "deny") {
    return { block: true, reason: verdict.reason };
  }

  // "ask": Pi can put the decision in front of the user, which is strictly
  // better than the agent guessing. Without a UI there is nobody to ask, so the
  // fail-closed posture applies and the command is blocked.
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `${verdict.reason} No interactive UI available to confirm, so blocking.`,
    };
  }

  const approved = await ctx.ui.confirm("demur", `${verdict.reason}\n\n${command}\n\nRun it anyway?`);
  if (approved) return undefined;

  return { block: true, reason: `${verdict.reason} Declined by the user.` };
}

/**
 * Pi extension entry point.
 *
 * Routes every bash tool call through a TypeSafe System One judgment before Pi
 * is allowed to execute it.
 *
 * @param pi - The extension API provided by Pi
 */
export default function demur(pi: ExtensionAPI): void {
  pi.on("tool_call", handleToolCall);
}
