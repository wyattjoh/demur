import {
  DEMUR_MODES,
  FAILURE_POLICIES,
  type DemurSettings,
} from "../extensions/demur/settings.ts";

/**
 * Settings exposed by both the Pi extension menu and the central TUI.
 */
export type DemurSettingKey = "mode" | "training" | "failurePolicy";

/**
 * Move one persisted demur setting to its next or previous supported value.
 *
 * Selecting disabled mode always turns training capture off. Training cannot be
 * changed while disabled, matching the persisted configuration invariant.
 *
 * @param settings - Current persisted settings
 * @param key - Setting to change
 * @param direction - Positive for the next value, negative for the previous
 * @returns The updated settings, or the original object when no change is valid
 */
export function changeDemurSetting(
  settings: DemurSettings,
  key: DemurSettingKey,
  direction: number,
): DemurSettings {
  if (key === "training") {
    if (settings.mode === "disabled") return settings;
    return { ...settings, training: !settings.training };
  }

  if (key === "mode") {
    const mode = cycleValue(DEMUR_MODES, settings.mode, direction);
    return {
      ...settings,
      mode,
      training: mode === "disabled" ? false : settings.training,
    };
  }

  return {
    ...settings,
    failurePolicy: cycleValue(
      FAILURE_POLICIES,
      settings.failurePolicy,
      direction,
    ),
  };
}

function cycleValue<Value>(
  values: ReadonlyArray<Value>,
  current: Value,
  direction: number,
): Value {
  const currentIndex = values.indexOf(current);
  const offset = direction < 0 ? values.length - 1 : 1;
  return values[(currentIndex + offset) % values.length] ?? current;
}
