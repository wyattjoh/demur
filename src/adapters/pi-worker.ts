#!/usr/bin/env bun
import { guard, guardWithEvidence } from "../guard.ts";

type GuardRequest = {
  command: string;
  cwd: string;
  includeEvidence: boolean;
};

const request = parseRequest(await Bun.stdin.text());
if (request.includeEvidence) {
  const evaluation = await guardWithEvidence(request.command, request.cwd, "pi");
  process.stdout.write(`${JSON.stringify(evaluation.verdict)}\n`);
  process.stdout.write(JSON.stringify(evaluation.evidence ?? null));
} else {
  process.stdout.write(
    JSON.stringify(await guard(request.command, request.cwd, "pi")),
  );
}

function parseRequest(input: string): GuardRequest {
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object") {
    throw new Error("guard request must be an object");
  }

  const { command, cwd, includeEvidence } = value as Record<string, unknown>;
  if (
    typeof command !== "string" ||
    typeof cwd !== "string" ||
    (includeEvidence !== undefined && typeof includeEvidence !== "boolean")
  ) {
    throw new Error(
      "guard request must contain string command and cwd fields and an optional boolean includeEvidence field",
    );
  }

  return { command, cwd, includeEvidence: includeEvidence === true };
}
