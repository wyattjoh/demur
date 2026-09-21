import { describe, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { DemurSettings } from "../extensions/demur/settings.ts";
import type { TrainingReviewSnapshot } from "./training-review-model.ts";
import { TrainingReviewApp } from "./training-review-tui.tsx";

const settings: DemurSettings = {
  mode: "enforce",
  training: false,
  failurePolicy: "block",
};

const fillerRecords: TrainingReviewSnapshot["records"] = Array.from(
  { length: 20 },
  (_, index) => ({
    version: 1,
    id: `filler-${index}`,
    recordedAt: "2026-01-03T00:00:00.000Z",
    command: `echo filler ${index}`,
    cwd: "/workspace",
    mode: "enforce",
    verdict: {
      decision: "allow",
      reason: "safe",
      judgments: undefined,
      failure: undefined,
      latencyMs: 5,
      usage: undefined,
    },
    hostAction: "allow",
  }),
);

const snapshot: TrainingReviewSnapshot = {
  records: [{
    version: 1,
    id: "long-command",
    recordedAt: "2026-01-01T00:00:00.000Z",
    command: `echo ${"a".repeat(120)}`,
    cwd: "/workspace",
    mode: "enforce",
    verdict: {
      decision: "allow",
      reason: "safe",
      judgments: undefined,
      failure: undefined,
      latencyMs: 12,
      usage: undefined,
    },
    hostAction: "allow",
  }, {
    version: 1,
    id: "short-command",
    recordedAt: "2026-01-02T00:00:00.000Z",
    command: "printf ok",
    cwd: "/workspace",
    mode: "enforce",
    verdict: {
      decision: "allow",
      reason: "safe",
      judgments: undefined,
      failure: undefined,
      latencyMs: 8,
      usage: undefined,
    },
    hostAction: "allow",
  }, ...fillerRecords],
  reviews: [],
  globalEstimatedCostUsd: 0,
};

describe("training review TUI", () => {
  it("keeps an overlong queue command and its status on adjacent rows", async () => {
    for (const width of [40, 60, 91, 92, 93, 100, 130, 148]) {
      const view = await testRender(
        <TrainingReviewApp
          snapshot={snapshot}
          settings={settings}
          reloadSnapshot={() => new Promise<TrainingReviewSnapshot>(() => {})}
          recordReview={async () => {
            throw new Error("not used");
          }}
          saveSettings={async () => {}}
          pollIntervalMs={60_000}
          onExit={() => {}}
        />,
        { width, height: 30 },
      );

      try {
        await act(async () => {
          await view.flush();
        });
        const frame = view.captureCharFrame();
        const lines = frame.split("\n");
        const commandIndex = lines.findIndex((line) =>
          line.includes("echo aaa")
        );
        const statusIndex = lines.findIndex((line, index) =>
          index > commandIndex && line.includes("not reviewed")
        );
        const nextCommandIndex = lines.findIndex((line) =>
          line.includes("printf ok")
        );

        if (commandIndex < 0 || nextCommandIndex < 0) {
          throw new Error(
            `queue commands were not rendered at width ${width}:\n${frame}`,
          );
        }
        if (
          statusIndex !== commandIndex + 1 ||
          nextCommandIndex !== statusIndex + 1
        ) {
          throw new Error(
            `long command occupied an extra queue row at width ${width}:\n${frame}`,
          );
        }

        const statusLine = lines[statusIndex] ?? "";
        if (
          !statusLine.includes("ALLOW") ||
          statusLine.includes("cost") ||
          statusLine.includes("0r")
        ) {
          throw new Error(
            `queue metadata did not show only status and model decision at width ${width}:\n${frame}`,
          );
        }
      } finally {
        await act(async () => {
          view.renderer.destroy();
        });
      }
    }
  }, 20_000);
});
