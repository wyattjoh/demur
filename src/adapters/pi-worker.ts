#!/usr/bin/env bun
import { guard } from "../guard.ts";

type GuardRequest = {
  command: string;
  cwd: string;
};

const request = parseRequest(await Bun.stdin.text());
const verdict = await guard(request.command, request.cwd, "pi");
process.stdout.write(JSON.stringify(verdict));

function parseRequest(input: string): GuardRequest {
  const value: unknown = JSON.parse(input);
  if (value === null || typeof value !== "object") {
    throw new Error("guard request must be an object");
  }

  const { command, cwd } = value as Record<string, unknown>;
  if (typeof command !== "string" || typeof cwd !== "string") {
    throw new Error("guard request must contain string command and cwd fields");
  }

  return { command, cwd };
}
