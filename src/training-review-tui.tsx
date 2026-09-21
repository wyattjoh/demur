import {
  createCliRenderer,
  type ScrollBoxRenderable,
} from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  estimateInputCostUsd,
  formatUsd,
} from "../extensions/demur/cost-tracker.ts";
import type { DemurSettings } from "../extensions/demur/settings.ts";
import type {
  TrainingCorrectionReason,
  TrainingReview,
  TrainingReviewInput,
} from "../extensions/demur/training-store.ts";
import {
  changeDemurSetting,
  type DemurSettingKey,
} from "./settings-model.ts";
import {
  buildTrainingReviewEntries,
  createTrainingReviewInput,
  filterTrainingReviewEntries,
  getLatestTrainingReview,
  getTrainingCorrectionReason,
  getTrainingReviewFilter,
  type TrainingReviewEntry,
  type TrainingReviewFilter,
  type TrainingReviewSnapshot,
} from "./training-review-model.ts";
import type { Decision } from "./types.ts";

const POLL_INTERVAL_MS = 1_000;

const COLORS = {
  background: "#111318",
  panel: "#181b22",
  border: "#3b4252",
  accent: "#88c0d0",
  text: "#eceff4",
  muted: "#8f98a8",
  allow: "#a3be8c",
  allowMuted: "#78906a",
  ask: "#ebcb8b",
  askMuted: "#a28f68",
  deny: "#bf616a",
  denyMuted: "#87515a",
  selection: "#2e3440",
  error: "#ff6b7a",
} as const;

const FILTERS: ReadonlyArray<{
  value: TrainingReviewFilter;
  label: string;
}> = [
  { value: "all", label: "all" },
  { value: "unreviewed", label: "not reviewed" },
  { value: "allow", label: "approved" },
  { value: "ask", label: "ask" },
  { value: "deny", label: "deny" },
];

const CORRECTION_REASONS: ReadonlyArray<{
  value: TrainingCorrectionReason;
  label: string;
}> = [
  { value: "inert-or-read-only", label: "Command is inert or read-only" },
  { value: "sensitive-data", label: "Sensitive-data judgment" },
  { value: "security-boundary", label: "Security-boundary judgment" },
  { value: "recoverability", label: "Recoverability judgment" },
  { value: "shared-infrastructure", label: "Local versus shared target" },
  { value: "blast-radius", label: "Blast-radius judgment" },
  { value: "static-uncertainty", label: "Static uncertainty gate" },
  { value: "missing-context", label: "Model was missing objective context" },
  { value: "service-failure", label: "TypeSafe or guard service failure" },
];

const SECTIONS: ReadonlyArray<{ value: AppSection; label: string }> = [
  { value: "reviews", label: "Reviews" },
  { value: "settings", label: "Settings" },
];

const SETTING_ROWS: ReadonlyArray<{
  key: DemurSettingKey;
  label: string;
  description: string;
}> = [
  {
    key: "mode",
    label: "Operating mode",
    description: "Enforce decisions, observe passively, or bypass the guard.",
  },
  {
    key: "training",
    label: "Training capture",
    description: "Append full evaluations for later human review.",
  },
  {
    key: "failurePolicy",
    label: "Failure policy",
    description: "Action when no trustworthy judgment is available.",
  },
];

/**
 * Summary returned after an interactive training-review session.
 */
export type TrainingReviewTuiResult = {
  reviewed: number;
  corrected: number;
  skipped: number;
};

type TrainingReviewAppProps = {
  snapshot: TrainingReviewSnapshot;
  settings: DemurSettings;
  reloadSnapshot(): Promise<TrainingReviewSnapshot>;
  recordReview(input: TrainingReviewInput): Promise<TrainingReview>;
  saveSettings(settings: DemurSettings): Promise<void>;
  pollIntervalMs: number | undefined;
  onExit(result: TrainingReviewTuiResult): void;
};

type NoteEditorState = {
  recordId: string;
  expectedDecision: Decision;
  correctionReason: TrainingCorrectionReason | undefined;
};

type AppSection = "reviews" | "settings";

type FocusTarget =
  | "sections"
  | "tabs"
  | "filter"
  | "queue"
  | "detail"
  | "settings";

/**
 * Render the interactive historical training-review queue.
 *
 * @param props - Training state, persistence callbacks, and exit callback
 * @returns OpenTUI React application tree
 */
export function TrainingReviewApp(
  props: TrainingReviewAppProps,
): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const queueRef = useRef<ScrollBoxRenderable | null>(null);
  const [snapshot, setSnapshot] = useState<TrainingReviewSnapshot>(
    props.snapshot,
  );
  const [section, setSection] = useState<AppSection>("reviews");
  const [settings, setSettings] = useState<DemurSettings>(props.settings);
  const [selectedSettingIndex, setSelectedSettingIndex] = useState(0);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [activeFilter, setActiveFilter] = useState<TrainingReviewFilter>(
    "all",
  );
  const [cwdQuery, setCwdQuery] = useState("");
  const [ready, setReady] = useState(false);
  const [focus, setFocus] = useState<FocusTarget>("queue");
  const [selectedRecordId, setSelectedRecordId] = useState<
    string | undefined
  >(undefined);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pollError, setPollError] = useState<string | undefined>();
  const [result, setResult] = useState<TrainingReviewTuiResult>({
    reviewed: 0,
    corrected: 0,
    skipped: 0,
  });

  const entries = useMemo(
    () => buildTrainingReviewEntries(snapshot),
    [snapshot],
  );
  const visibleEntries = useMemo(
    () => filterTrainingReviewEntries(entries, activeFilter, cwdQuery)
      .filter((entry) => !dismissedIds.has(entry.record.id)),
    [activeFilter, cwdQuery, dismissedIds, entries],
  );
  const selectedIndex = Math.max(
    0,
    visibleEntries.findIndex(
      (entry) => entry.record.id === selectedRecordId,
    ),
  );
  const selected = visibleEntries[selectedIndex];
  const latestReview = selected === undefined
    ? undefined
    : getLatestTrainingReview(selected);
  const editingEntry = noteEditor === undefined
    ? undefined
    : entries.find((entry) => entry.record.id === noteEditor.recordId);
  const counts = useMemo(
    () => countByFilter(entries),
    [entries],
  );
  const horizontal = width >= 92;
  const queueSize = horizontal
    ? Math.max(28, Math.min(42, Math.floor(width * 0.34)))
    : Math.max(7, Math.min(11, Math.floor(height * 0.32)));
  const queuePageSize = Math.max(
    1,
    Math.floor((horizontal ? height - 16 : queueSize - 2) / 2),
  );
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const loaded = await props.reloadSnapshot();
        if (!active) return;
        setSnapshot((current) =>
          trainingSnapshotsEqual(current, loaded) ? current : loaded
        );
        setPollError(undefined);
      } catch (cause: unknown) {
        if (active) setPollError(errorDetail(cause));
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = setInterval(
      () => void poll(),
      props.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [props.pollIntervalMs, props.reloadSnapshot]);

  useEffect(() => {
    if (
      noteEditor !== undefined &&
      !entries.some((entry) => entry.record.id === noteEditor.recordId)
    ) {
      setNoteEditor(undefined);
    }
  }, [entries, noteEditor]);

  useEffect(() => {
    if (selected === undefined) return;
    queueRef.current?.scrollChildIntoView(queueRowId(selected.record.id));
  }, [selected]);

  const finish = (nextResult: TrainingReviewTuiResult) => {
    props.onExit(nextResult);
  };

  const persistSetting = async (
    key: DemurSettingKey,
    direction: number,
  ) => {
    if (savingSettings) return;
    const nextSettings = changeDemurSetting(settings, key, direction);
    if (nextSettings === settings) return;

    setSavingSettings(true);
    setSettingsError(undefined);
    try {
      await props.saveSettings(nextSettings);
      setSettings(nextSettings);
    } catch (cause: unknown) {
      setSettingsError(errorDetail(cause));
    } finally {
      setSavingSettings(false);
    }
  };

  const persistDecision = async (
    entry: TrainingReviewEntry,
    expectedDecision: Decision,
    correctionReason: TrainingCorrectionReason | undefined,
    note: string | undefined,
  ) => {
    if (saving) return;
    const previous = getLatestTrainingReview(entry);
    if (
      previous?.expectedDecision === expectedDecision &&
      correctionReason === undefined &&
      note === undefined
    ) {
      setNoteEditor(undefined);
      return;
    }

    setSaving(true);
    setError(undefined);
    const corrected = expectedDecision !== entry.record.verdict.decision;
    try {
      const review = await props.recordReview(
        createTrainingReviewInput(
          entry.record,
          expectedDecision,
          correctionReason,
          note,
        ),
      );
      setSnapshot((current) =>
        current.reviews.some((existing) =>
            existing.recordId === review.recordId &&
            existing.reviewedAt === review.reviewedAt
          )
          ? current
          : {
            records: current.records,
            reviews: [...current.reviews, review],
            globalEstimatedCostUsd: current.globalEstimatedCostUsd,
          }
      );
      setResult((current) => ({
        ...current,
        reviewed: current.reviewed + 1,
        corrected: current.corrected + (corrected ? 1 : 0),
      }));
      setNoteEditor(undefined);
      setError(undefined);
    } catch (cause: unknown) {
      setError(errorDetail(cause));
    } finally {
      setSaving(false);
    }
  };

  const chooseDecision = (decision: Decision) => {
    if (selected === undefined || saving) return;
    if (decision === selected.record.verdict.decision) {
      void persistDecision(selected, decision, undefined, undefined);
      return;
    }
    setError(undefined);
    setNoteEditor({
      recordId: selected.record.id,
      expectedDecision: decision,
      correctionReason: undefined,
    });
  };

  const skipSelected = () => {
    if (selected === undefined || saving) return;
    setDismissedIds((current) => new Set([
      ...current,
      selected.record.id,
    ]));
    setResult((current) => ({ ...current, skipped: current.skipped + 1 }));
    setNoteEditor(undefined);
    setError(undefined);
  };

  const rotateFilter = (reverse: boolean) => {
    const currentIndex = FILTERS.findIndex(
      (filter) => filter.value === activeFilter,
    );
    const offset = reverse ? FILTERS.length - 1 : 1;
    const next = FILTERS[(currentIndex + offset) % FILTERS.length];
    if (next !== undefined) setActiveFilter(next.value);
  };

  const moveFilterSelection = (offset: number) => {
    const currentIndex = FILTERS.findIndex(
      (filter) => filter.value === activeFilter,
    );
    const bounded = Math.max(
      0,
      Math.min(currentIndex + offset, FILTERS.length - 1),
    );
    const filter = FILTERS[bounded];
    if (filter !== undefined) setActiveFilter(filter.value);
  };

  const moveQueueSelection = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visibleEntries.length - 1));
    const entry = visibleEntries[bounded];
    if (entry !== undefined) setSelectedRecordId(entry.record.id);
  };

  useKeyboard((key) => {
    if (!ready) {
      key.preventDefault();
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      finish(result);
      return;
    }

    if (noteEditor !== undefined) {
      if (key.name === "escape") {
        key.preventDefault();
        setNoteEditor(undefined);
        setError(undefined);
        return;
      }

      if (noteEditor.correctionReason === undefined) {
        const reason = correctionReasonForKey(key.name, key.sequence);
        if (reason !== undefined) {
          key.preventDefault();
          setNoteEditor({ ...noteEditor, correctionReason: reason });
        }
        return;
      }

      if (key.name === "tab") key.preventDefault();
      return;
    }

    const sectionKey = key.sequence || key.name;
    if (focus !== "filter" && (sectionKey === "[" || sectionKey === "]")) {
      key.preventDefault();
      const nextSection = sectionKey === "[" ? "reviews" : "settings";
      setSection(nextSection);
      setFocus(nextSection === "reviews" ? "tabs" : "settings");
      return;
    }

    if (focus === "sections") {
      if (key.name === "left" || key.name === "right") {
        key.preventDefault();
        setSection((current) =>
          current === "reviews" ? "settings" : "reviews"
        );
        return;
      }
      if (key.name === "down" || key.name === "return") {
        key.preventDefault();
        setFocus(section === "reviews" ? "tabs" : "settings");
        return;
      }
      if (key.name === "q" || key.name === "escape") {
        key.preventDefault();
        finish(result);
      }
      return;
    }

    if (section === "settings") {
      if (key.name === "q" || key.name === "escape") {
        key.preventDefault();
        finish(result);
        return;
      }
      if (key.name === "up") {
        key.preventDefault();
        if (selectedSettingIndex === 0) {
          setFocus("sections");
        } else {
          setSelectedSettingIndex((current) => current - 1);
        }
        return;
      }
      if (key.name === "down") {
        key.preventDefault();
        setSelectedSettingIndex((current) =>
          Math.min(current + 1, SETTING_ROWS.length - 1)
        );
        return;
      }
      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "return" ||
        key.name === "space" ||
        key.sequence === " "
      ) {
        key.preventDefault();
        const row = SETTING_ROWS[selectedSettingIndex];
        if (row !== undefined) {
          void persistSetting(row.key, key.name === "left" ? -1 : 1);
        }
      }
      return;
    }

    if (key.name === "tab") {
      key.preventDefault();
      rotateFilter(key.shift);
      return;
    }

    if (focus === "tabs") {
      if (key.name === "up") {
        key.preventDefault();
        setFocus("sections");
        return;
      }
      if (key.name === "left" || key.name === "right") {
        key.preventDefault();
        moveFilterSelection(key.name === "left" ? -1 : 1);
        return;
      }
      if (key.name === "down" || key.name === "return") {
        key.preventDefault();
        setFocus("filter");
        return;
      }
      if (key.name === "q" || key.name === "escape") {
        key.preventDefault();
        finish(result);
      }
      return;
    }

    if (focus === "filter") {
      if (key.name === "up") {
        key.preventDefault();
        setFocus("tabs");
        return;
      }
      if (key.name === "down" || key.name === "return") {
        key.preventDefault();
        setFocus("queue");
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        if (cwdQuery === "") setFocus("queue");
        else setCwdQuery("");
      }
      return;
    }

    if (focus === "detail") {
      if (key.name === "left") {
        key.preventDefault();
        setFocus("queue");
        return;
      }
      if (key.name === "q" || key.name === "escape") {
        key.preventDefault();
        finish(result);
      }
      return;
    }

    if (key.name === "right") {
      key.preventDefault();
      setFocus("detail");
      return;
    }
    if (key.name === "j" || key.name === "k") {
      key.preventDefault();
      return;
    }
    if (key.name === "up") {
      key.preventDefault();
      if (visibleEntries.length === 0 || selectedIndex === 0) {
        setFocus("filter");
      } else {
        moveQueueSelection(selectedIndex - 1);
      }
      return;
    }
    if (key.name === "down") {
      key.preventDefault();
      moveQueueSelection(selectedIndex + 1);
      return;
    }
    if (key.name === "pageup") {
      key.preventDefault();
      moveQueueSelection(selectedIndex - queuePageSize);
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      moveQueueSelection(selectedIndex + queuePageSize);
      return;
    }

    if (saving) return;
    if (key.name === "q" || key.name === "escape") {
      key.preventDefault();
      finish(result);
      return;
    }
    if (key.name === "s") {
      key.preventDefault();
      skipSelected();
      return;
    }
    if (key.name === "return") {
      key.preventDefault();
      if (selected !== undefined) {
        chooseDecision(selected.record.verdict.decision);
      }
      return;
    }

    const decision = decisionForKey(key.name, key.sequence);
    if (decision !== undefined) {
      key.preventDefault();
      chooseDecision(decision);
    }
  });

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={COLORS.background}
      padding={1}
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={COLORS.accent}><strong>demur</strong></text>
          <text fg={COLORS.muted}>
            {`global est. ${formatUsd(snapshot.globalEstimatedCostUsd)}`}
          </text>
        </box>
        <text fg={COLORS.muted}>
          {`${entries.length} total · ${counts.unreviewed} new · ${counts.allow} approved · ${counts.ask} ask · ${counts.deny} deny`}
        </text>
      </box>

      <box
        title=" View "
        titleColor={focus === "sections" ? COLORS.accent : COLORS.muted}
        flexDirection="row"
        gap={1}
        border
        borderColor={focus === "sections" ? COLORS.accent : COLORS.border}
        backgroundColor={COLORS.panel}
        height={3}
        paddingLeft={1}
        paddingRight={1}
      >
        {SECTIONS.map((candidate) => {
          const active = candidate.value === section;
          return (
            <text
              key={candidate.value}
              fg={active ? COLORS.accent : COLORS.muted}
              bg={active ? COLORS.selection : COLORS.background}
              onMouseDown={() => {
                setSection(candidate.value);
                setFocus("sections");
              }}
            >
              {` ${candidate.label} `}
            </text>
          );
        })}
        <text fg={COLORS.muted}>[ / ] switch · Up to focus · ←/→ switch</text>
      </box>

      {section === "reviews"
        ? (
          <>
      <box
        title=" Review status "
        titleColor={focus === "tabs" ? COLORS.accent : COLORS.muted}
        flexDirection="row"
        gap={1}
        border
        borderColor={focus === "tabs" ? COLORS.accent : COLORS.border}
        backgroundColor={COLORS.panel}
        height={3}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => setFocus("tabs")}
      >
        {FILTERS.map((filter) => {
          const active = filter.value === activeFilter;
          return (
            <text
              key={filter.value}
              fg={active ? statusColor(filter.value) : COLORS.muted}
              bg={active ? COLORS.selection : COLORS.background}
              onMouseDown={() => {
                setActiveFilter(filter.value);
                setFocus("tabs");
              }}
            >
              {` ${filter.label} `}
            </text>
          );
        })}
        <text fg={COLORS.muted}>Tab / Shift-Tab</text>
      </box>

      <box
        title=" Working directory filter "
        titleColor={focus === "filter" ? COLORS.accent : COLORS.muted}
        border
        borderColor={focus === "filter" ? COLORS.accent : COLORS.border}
        backgroundColor={COLORS.panel}
        height={3}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => setFocus("filter")}
      >
        <input
          value={cwdQuery}
          placeholder="Up from the first result to filter by cwd"
          focused={ready && focus === "filter"}
          onInput={(value) => {
            setCwdQuery(typeof value === "string" ? value : "");
          }}
          onSubmit={() => setFocus("queue")}
        />
      </box>

      <box
        flexDirection={horizontal ? "row" : "column"}
        flexGrow={1}
        gap={1}
      >
        <box
          title={` Queue (${visibleEntries.length}) `}
          titleColor={COLORS.accent}
          border
          borderColor={focus === "queue" && noteEditor === undefined
            ? COLORS.accent
            : COLORS.border}
          backgroundColor={COLORS.panel}
          width={horizontal ? queueSize : "100%"}
          height={horizontal ? "100%" : queueSize}
          onMouseDown={() => setFocus("queue")}
          onMouseScroll={() => setFocus("queue")}
        >
          {selected === undefined
            ? (
              <box
                width="100%"
                height="100%"
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                gap={1}
              >
                <text fg={COLORS.allow}><strong>{emptyTitle(entries, cwdQuery)}</strong></text>
                <text fg={COLORS.muted}>{emptyDetail(entries, cwdQuery, activeFilter)}</text>
              </box>
            )
            : (
              <scrollbox
                ref={queueRef}
                height="100%"
                focused={ready && focus === "queue" && noteEditor === undefined}
                onMouseScroll={() => setFocus("queue")}
              >
                {visibleEntries.map((entry) => {
                  const entrySelected = entry.record.id === selected.record.id;
                  return (
                    <box
                      key={entry.record.id}
                      id={queueRowId(entry.record.id)}
                      flexDirection="column"
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={entrySelected
                        ? COLORS.selection
                        : COLORS.panel}
                      onMouseDown={() => {
                        setSelectedRecordId(entry.record.id);
                        setFocus("queue");
                      }}
                    >
                      <text
                        fg={entrySelected
                          ? statusColor(getTrainingReviewFilter(entry))
                          : COLORS.text}
                        wrapMode="none"
                        truncate
                      >
                        {`${entrySelected ? "▶" : " "} ${summarizeCommand(entry.record.command, horizontal ? queueSize - 6 : width - 8)}`}
                      </text>
                      <text
                        fg={entrySelected ? COLORS.accent : COLORS.muted}
                        wrapMode="none"
                        truncate
                      >
                        {`  ${statusLabel(getTrainingReviewFilter(entry))} · `}
                        <span
                          fg={mutedDecisionColor(
                            entry.record.verdict.decision,
                          )}
                        >
                          {entry.record.verdict.decision.toUpperCase()}
                        </span>
                      </text>
                    </box>
                  );
                })}
              </scrollbox>
            )}
        </box>

        <box
          title=" Evidence and review history "
          titleColor={selected === undefined
            ? COLORS.muted
            : statusColor(getTrainingReviewFilter(selected))}
          border
          borderColor={focus === "detail" && noteEditor === undefined
            ? COLORS.accent
            : COLORS.border}
          backgroundColor={COLORS.panel}
          flexGrow={1}
          minHeight={10}
          onMouseDown={() => setFocus("detail")}
          onMouseScroll={() => setFocus("detail")}
        >
          {selected === undefined
            ? (
              <box
                width="100%"
                height="100%"
                alignItems="center"
                justifyContent="center"
              >
                <text fg={COLORS.muted}>
                  Watching training state for new evaluations and reviews…
                </text>
              </box>
            )
            : (
              <scrollbox
                key={selected.record.id}
                height="100%"
                focused={ready && focus === "detail" && noteEditor === undefined}
                onMouseScroll={() => setFocus("detail")}
              >
                <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={1}>
                  <DetailRow
                    label="Latest human answer"
                    value={statusLabel(getTrainingReviewFilter(selected))}
                    color={statusColor(getTrainingReviewFilter(selected))}
                  />
                  <DetailRow
                    label="Model decision"
                    value={selected.record.verdict.decision.toUpperCase()}
                    color={decisionColor(selected.record.verdict.decision)}
                  />
                  <DetailRow label="Reason" value={selected.record.verdict.reason} color={undefined} />
                  <DetailRow label="Command" value={selected.record.command} color={COLORS.text} />
                  <DetailRow label="Working directory" value={selected.record.cwd} color={undefined} />
                  <DetailRow label="Captured" value={selected.record.recordedAt} color={undefined} />
                  <DetailRow label="Mode / host action" value={`${selected.record.mode} / ${selected.record.hostAction}`} color={undefined} />
                  {selected.record.verdict.failure === undefined
                    ? null
                    : <DetailRow label="Failure" value={selected.record.verdict.failure} color={COLORS.error} />}
                  {selected.record.verdict.judgments === undefined
                    ? null
                    : <JudgmentsTable entry={selected} />}
                  <DetailRow
                    label="Evaluation"
                    value={`${selected.record.verdict.latencyMs} ms${formatUsage(selected)}`}
                    color={undefined}
                  />
                  <box flexDirection="column" gap={1}>
                    <text fg={COLORS.muted}>Review history</text>
                    {selected.reviews.length === 0
                      ? <text fg={COLORS.text}>No human reviews yet.</text>
                      : selected.reviews.map((review, index) => (
                        <box key={`${review.reviewedAt}-${index}`} flexDirection="column">
                          <text fg={decisionColor(review.expectedDecision)}>
                            {`${index + 1}. ${review.expectedDecision.toUpperCase()} · ${review.reviewedAt}`}
                          </text>
                          {getTrainingCorrectionReason(review) === undefined
                            ? null
                            : (
                              <text fg={COLORS.muted} wrapMode="word">
                                {`Reason: ${correctionReasonLabel(getTrainingCorrectionReason(review)!)}`}
                              </text>
                            )}
                          {review.note === undefined
                            ? null
                            : <text fg={COLORS.text} wrapMode="word">{review.note}</text>}
                        </box>
                      ))}
                  </box>
                </box>
              </scrollbox>
            )}
        </box>
      </box>

      {noteEditor !== undefined && editingEntry !== undefined
        ? noteEditor.correctionReason === undefined
          ? (
            <box
              title={` Why ${statusLabel(getTrainingReviewFilter(editingEntry))} → ${noteEditor.expectedDecision}? `}
              titleColor={decisionColor(noteEditor.expectedDecision)}
              border
              borderColor={decisionColor(noteEditor.expectedDecision)}
              height={CORRECTION_REASONS.length + 3}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
            >
              {CORRECTION_REASONS.map((reason, index) => (
                <text key={reason.value} fg={COLORS.text}>
                  {`${index + 1}. ${reason.label}`}
                </text>
              ))}
              <text fg={COLORS.muted}>1–9 select reason · Esc cancel</text>
            </box>
          )
          : (
            <box
              title={` ${correctionReasonLabel(noteEditor.correctionReason)} `}
              titleColor={decisionColor(noteEditor.expectedDecision)}
              border
              borderColor={decisionColor(noteEditor.expectedDecision)}
              height={5}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
            >
              <input
                placeholder="Optional correction note — Enter saves, Esc cancels"
                focused
                onSubmit={(note) => {
                  void persistDecision(
                    editingEntry,
                    noteEditor.expectedDecision,
                    noteEditor.correctionReason,
                    typeof note === "string" ? note : undefined,
                  );
                }}
              />
              <text fg={COLORS.muted}>Enter save revision · Esc cancel</text>
            </box>
          )
        : null}

      {error === undefined
        ? null
        : <text fg={COLORS.error}>Could not save review: {error}</text>}
      {pollError === undefined
        ? null
        : <text fg={COLORS.error}>Could not refresh training state: {pollError}</text>}

      <box flexDirection="row" justifyContent="space-between">
        <text fg={COLORS.muted}>
          {focus === "tabs"
            ? "←/→ select status · Up sections · Down/Enter filter · Tab rotates"
            : focus === "filter"
            ? "Type to fuzzy-search cwd · Up tabs · Down/Enter queue · Tab rotates"
            : focus === "detail"
            ? "↑/↓ or j/k scroll · Page Up/Down page · Left queue · Tab rotates"
            : "↑/↓ navigate · Page Up/Down page · Right details · ↑ from first filters · Enter original · 1/2/3 decide · s skip"}
        </text>
        <text fg={saving ? COLORS.ask : COLORS.muted}>
          {saving ? "Saving…" : "q/Esc quit"}
        </text>
      </box>
          </>
        )
        : (
          <>
            <box
              title=" Pi extension settings "
              titleColor={COLORS.accent}
              border
              borderColor={COLORS.accent}
              backgroundColor={COLORS.panel}
              flexGrow={1}
              flexDirection="column"
              padding={1}
              gap={1}
            >
              <text fg={COLORS.muted} wrapMode="word">
                Changes are saved globally and picked up by Pi before its next Bash call.
              </text>
              {SETTING_ROWS.map((row, index) => {
                const selectedRow = index === selectedSettingIndex;
                const unavailable = row.key === "training" &&
                  settings.mode === "disabled";
                return (
                  <box
                    key={row.key}
                    flexDirection="column"
                    backgroundColor={selectedRow
                      ? COLORS.selection
                      : COLORS.panel}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseDown={() => {
                      setSelectedSettingIndex(index);
                      setFocus("settings");
                    }}
                  >
                    <box flexDirection="row">
                      <text
                        width={24}
                        fg={selectedRow ? COLORS.accent : COLORS.text}
                      >
                        {`${selectedRow ? "▶" : " "} ${row.label}`}
                      </text>
                      <text fg={unavailable ? COLORS.muted : COLORS.allow}>
                        {settingDisplayValue(settings, row.key)}
                      </text>
                    </box>
                    <text fg={COLORS.muted} wrapMode="word">
                      {unavailable
                        ? "Unavailable while the operating mode is disabled."
                        : row.description}
                    </text>
                  </box>
                );
              })}
            </box>

            {settingsError === undefined
              ? null
              : (
                <text fg={COLORS.error}>
                  Could not save settings: {settingsError}
                </text>
              )}

            <box flexDirection="row" justifyContent="space-between">
              <text fg={COLORS.muted}>
                ↑/↓ select · ←/→ change · Enter/Space next · [ reviews
              </text>
              <text fg={savingSettings ? COLORS.ask : COLORS.muted}>
                {savingSettings ? "Saving…" : "q/Esc quit"}
              </text>
            </box>
          </>
        )}
    </box>
  );
}

type DetailRowProps = {
  label: string;
  value: string;
  color: string | undefined;
};

function DetailRow(props: DetailRowProps): React.ReactNode {
  return (
    <box flexDirection="column">
      <text fg={COLORS.muted}>{props.label}</text>
      <text fg={props.color ?? COLORS.text} wrapMode="word" selectable>
        {props.value}
      </text>
    </box>
  );
}

type JudgmentRow = {
  label: string;
  value: string;
};

function JudgmentsTable(props: { entry: TrainingReviewEntry }): React.ReactNode {
  const rows = judgmentRows(props.entry);
  return (
    <box flexDirection="column">
      <text fg={COLORS.muted}>Judgments</text>
      <box border borderColor={COLORS.border} flexDirection="column">
        <box flexDirection="row" backgroundColor={COLORS.selection}>
          <text width={30} fg={COLORS.accent}><strong>Judgment</strong></text>
          <text flexGrow={1} fg={COLORS.accent}><strong>Score</strong></text>
        </box>
        {rows.map((row) => (
          <box key={row.label} flexDirection="row">
            <text width={30} fg={COLORS.text}>{row.label}</text>
            <text flexGrow={1} fg={COLORS.text}>{row.value}</text>
          </box>
        ))}
      </box>
    </box>
  );
}

/**
 * Launch OpenTUI for complete training history and restore the terminal on exit.
 *
 * @param snapshot - Complete training state to present initially
 * @param settings - Current globally persisted Pi extension settings
 * @param reloadSnapshot - Polling callback that returns current training state
 * @param recordReview - Persistence callback for review revisions
 * @param saveSettings - Atomic persistence callback for Pi extension settings
 * @returns Counts for the completed interactive session
 */
export async function runTrainingReviewTui(
  snapshot: TrainingReviewSnapshot,
  settings: DemurSettings,
  reloadSnapshot: () => Promise<TrainingReviewSnapshot>,
  recordReview: (input: TrainingReviewInput) => Promise<TrainingReview>,
  saveSettings: (settings: DemurSettings) => Promise<void>,
): Promise<TrainingReviewTuiResult> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    useMouse: true,
    targetFps: 30,
  });
  const root = createRoot(renderer);

  return await new Promise<TrainingReviewTuiResult>((resolve) => {
    let finished = false;
    const finish = (result: TrainingReviewTuiResult) => {
      if (finished) return;
      finished = true;
      root.unmount();
      renderer.destroy();
      resolve(result);
    };

    root.render(
      <TrainingReviewApp
        snapshot={snapshot}
        settings={settings}
        reloadSnapshot={reloadSnapshot}
        recordReview={recordReview}
        saveSettings={saveSettings}
        pollIntervalMs={undefined}
        onExit={finish}
      />,
    );
  });
}

function settingDisplayValue(
  settings: DemurSettings,
  key: DemurSettingKey,
): string {
  if (key === "mode") return settings.mode;
  if (key === "training") return settings.training ? "on" : "off";
  return settings.failurePolicy;
}

function countByFilter(
  entries: ReadonlyArray<TrainingReviewEntry>,
): Record<TrainingReviewFilter, number> {
  const counts: Record<TrainingReviewFilter, number> = {
    all: entries.length,
    unreviewed: 0,
    allow: 0,
    ask: 0,
    deny: 0,
  };
  for (const entry of entries) counts[getTrainingReviewFilter(entry)] += 1;
  return counts;
}

function trainingSnapshotsEqual(
  left: TrainingReviewSnapshot,
  right: TrainingReviewSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function queueRowId(recordId: string): string {
  return `training-queue-${recordId}`;
}

function summarizeCommand(command: string, maximumLength: number): string {
  const singleLine = command.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= maximumLength) return singleLine;
  return `${singleLine.slice(0, Math.max(1, maximumLength - 1))}…`;
}

function decisionForKey(
  name: string,
  sequence: string,
): Decision | undefined {
  const key = sequence || name;
  if (key === "1") return "allow";
  if (key === "2") return "ask";
  if (key === "3") return "deny";
  return undefined;
}

function correctionReasonForKey(
  name: string,
  sequence: string,
): TrainingCorrectionReason | undefined {
  const index = Number(sequence || name) - 1;
  return Number.isInteger(index) ? CORRECTION_REASONS[index]?.value : undefined;
}

function correctionReasonLabel(reason: TrainingCorrectionReason): string {
  return CORRECTION_REASONS.find((candidate) => candidate.value === reason)
    ?.label ?? reason;
}

function statusLabel(filter: TrainingReviewFilter): string {
  return {
    all: "ALL",
    unreviewed: "not reviewed",
    allow: "APPROVED",
    ask: "ASK",
    deny: "DENY",
  }[filter];
}

function statusColor(filter: TrainingReviewFilter): string {
  return filter === "all" || filter === "unreviewed"
    ? COLORS.accent
    : decisionColor(filter);
}

function decisionColor(decision: Decision): string {
  return {
    allow: COLORS.allow,
    ask: COLORS.ask,
    deny: COLORS.deny,
  }[decision];
}

function mutedDecisionColor(decision: Decision): string {
  return {
    allow: COLORS.allowMuted,
    ask: COLORS.askMuted,
    deny: COLORS.denyMuted,
  }[decision];
}

function emptyTitle(
  entries: ReadonlyArray<TrainingReviewEntry>,
  cwdQuery: string,
): string {
  if (entries.length === 0) return "No training history yet";
  if (cwdQuery.trim() !== "") return "No matching working directories";
  return "Nothing in this status";
}

function emptyDetail(
  entries: ReadonlyArray<TrainingReviewEntry>,
  cwdQuery: string,
  filter: TrainingReviewFilter,
): string {
  if (entries.length === 0) return "Waiting for captured evaluations";
  if (cwdQuery.trim() !== "") return "Up to edit the cwd filter · Tab changes status";
  if (filter === "all") return "No visible entries · Tab changes status";
  return `No ${statusLabel(filter).toLowerCase()} entries · Tab changes status`;
}

function judgmentRows(
  entry: TrainingReviewEntry,
): ReadonlyArray<JudgmentRow> {
  const judgments = entry.record.verdict.judgments;
  if (judgments === undefined) return [];
  return [
    {
      label: "Executes destruction",
      value: judgments.executesDestruction.toFixed(3),
    },
    {
      label: "Sensitive-data exposure",
      value: judgments.exposesSensitiveData.toFixed(3),
    },
    {
      label: "Weakens security boundary",
      value: judgments.weakensSecurityBoundary.toFixed(3),
    },
    {
      label: "Unrecoverable",
      value: judgments.unrecoverable.toFixed(3),
    },
    {
      label: "Shared infrastructure",
      value: judgments.targetsSharedInfrastructure.toFixed(3),
    },
    {
      label: "Blast radius",
      value: `${judgments.blastRadius.toFixed(2)} / 3`,
    },
    {
      label: "Blast-radius confidence",
      value: judgments.blastRadiusConfidence.toFixed(2),
    },
  ];
}

function formatUsage(entry: TrainingReviewEntry): string {
  const usage = entry.record.verdict.usage;
  return usage === undefined
    ? ""
    : ` · ${usage.inputTokens} input / ${usage.outputTokens} output tokens · estimated cost ${formatUsd(estimateInputCostUsd(usage.inputTokens))}`;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
