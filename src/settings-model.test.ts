import { assert, describe, it } from "@effect/vitest";
import type { DemurSettings } from "../extensions/demur/settings.ts";
import { changeDemurSetting } from "./settings-model.ts";

const settings: DemurSettings = {
  mode: "enforce",
  training: true,
  failurePolicy: "block",
};

describe("TUI settings model", () => {
  it("cycles every setting in both directions", () => {
    assert.deepEqual(changeDemurSetting(settings, "mode", 1), {
      ...settings,
      mode: "passive",
    });
    assert.deepEqual(changeDemurSetting(settings, "mode", -1), {
      ...settings,
      mode: "disabled",
      training: false,
    });
    assert.deepEqual(changeDemurSetting(settings, "failurePolicy", 1), {
      ...settings,
      failurePolicy: "ask",
    });
    assert.deepEqual(changeDemurSetting(settings, "failurePolicy", -1), {
      ...settings,
      failurePolicy: "allow",
    });
  });

  it("toggles training only while demur is active", () => {
    assert.deepEqual(changeDemurSetting(settings, "training", 1), {
      ...settings,
      training: false,
    });

    const disabled: DemurSettings = {
      ...settings,
      mode: "disabled",
      training: false,
    };
    assert.strictEqual(
      changeDemurSetting(disabled, "training", 1),
      disabled,
    );
  });
});
