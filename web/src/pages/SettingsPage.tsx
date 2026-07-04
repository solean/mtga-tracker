import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { StatusMessage } from "../components/StatusMessage";
import { api } from "../lib/api";
import { formatDateTime, formatRelativeTime, shortenHomePath } from "../lib/format";
import { useThemeControls } from "../lib/theme";
import type { RuntimeConfig, RuntimeOperation, RuntimeStatus, UpdateCheck } from "../lib/types";

function StatusPill({
  tone,
  pulsing,
  children,
}: {
  tone: "positive" | "negative" | "neutral";
  pulsing?: boolean;
  children: ReactNode;
}) {
  const toneClass = tone === "neutral" ? "" : tone === "positive" ? " is-positive" : " is-negative";
  return <span className={`settings-status-pill${toneClass}${pulsing ? " is-pulsing" : ""}`}>{children}</span>;
}

function PathValue({ path }: { path: string }) {
  return (
    <code className="settings-path" title={path}>
      {shortenHomePath(path)}
    </code>
  );
}

const runtimeStatusKey = ["runtime-status"] as const;
const autostartKey = ["autostart-status"] as const;

function summarizeUpdateCheck(result: UpdateCheck): string {
  if (result.note) {
    return result.note;
  }
  if (result.updateAvailable && result.latestVersion) {
    return `Update available: ${result.latestVersion} (current ${result.currentVersion})`;
  }
  return `Up to date (${result.currentVersion})`;
}

function formatRuntimeDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "-";
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function summarizeOperation(operation?: RuntimeOperation): string {
  if (!operation) {
    return "No runs yet.";
  }
  return [
    `${operation.matchesUpserted} matches`,
    `${operation.decksUpserted} decks`,
    `${operation.draftPicksAdded} picks`,
    formatRuntimeDuration(operation.durationMs),
  ].join(" • ");
}

async function refreshDataQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: runtimeStatusKey }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
    queryClient.invalidateQueries({ queryKey: ["rank-history"] }),
    queryClient.invalidateQueries({ queryKey: ["matches"] }),
    queryClient.invalidateQueries({ queryKey: ["decks"] }),
    queryClient.invalidateQueries({ queryKey: ["drafts"] }),
  ]);
}

function normalizePollInterval(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2;
  }
  return parsed;
}

function syncForm(status: RuntimeStatus): RuntimeConfig {
  return {
    logPath: status.config.logPath ?? "",
    pollIntervalSeconds: status.config.pollIntervalSeconds,
    includePrev: status.config.includePrev,
  };
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { theme, setTheme } = useThemeControls();
  const { data, isLoading, error } = useQuery({
    queryKey: runtimeStatusKey,
    queryFn: api.runtimeStatus,
    refetchInterval: 3000,
  });

  const [form, setForm] = useState<RuntimeConfig>({
    logPath: "",
    pollIntervalSeconds: 2,
    includePrev: true,
  });
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [dismissedError, setDismissedError] = useState("");

  useEffect(() => {
    if (!data || hasLocalEdits) {
      return;
    }
    setForm(syncForm(data));
  }, [data, hasLocalEdits]);

  useEffect(() => {
    if (!savedFlash) {
      return;
    }
    const timer = window.setTimeout(() => setSavedFlash(false), 2000);
    return () => window.clearTimeout(timer);
  }, [savedFlash]);

  const saveMutation = useMutation({
    mutationFn: () => api.saveRuntimeConfig(form),
    onSuccess: (status) => {
      queryClient.setQueryData(runtimeStatusKey, status);
      setForm(syncForm(status));
      setHasLocalEdits(false);
      setSavedFlash(true);
    },
  });

  const importMutation = useMutation({
    mutationFn: () => api.runImport(true),
    onSuccess: async () => {
      await refreshDataQueries(queryClient);
    },
  });

  const startLiveMutation = useMutation({
    mutationFn: api.startLive,
    onSuccess: (status) => {
      queryClient.setQueryData(runtimeStatusKey, status);
    },
  });

  const stopLiveMutation = useMutation({
    mutationFn: api.stopLive,
    onSuccess: (status) => {
      queryClient.setQueryData(runtimeStatusKey, status);
    },
  });

  const autostartQuery = useQuery({
    queryKey: autostartKey,
    queryFn: api.autostartStatus,
    staleTime: 60_000,
  });

  const autostartMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setAutostart(enabled),
    onSuccess: (status) => {
      queryClient.setQueryData(autostartKey, status);
    },
  });

  const updateCheckMutation = useMutation({
    mutationFn: api.checkForUpdate,
  });

  const pollOptions = useMemo(() => {
    const base = [1, 2, 5, 10];
    if (!base.includes(form.pollIntervalSeconds)) {
      base.push(form.pollIntervalSeconds);
    }
    return base.sort((a, b) => a - b);
  }, [form.pollIntervalSeconds]);

  if (isLoading) return <StatusMessage>Loading runtime settings…</StatusMessage>;
  if (error) return <StatusMessage tone="error">{(error as Error).message}</StatusMessage>;
  if (!data) return <StatusMessage>No runtime status available.</StatusMessage>;

  const effectiveActivePath = form.logPath.trim() || data.defaultLogPath;
  const saveDisabled = saveMutation.isPending || !hasLocalEdits;
  const liveMutationPending = startLiveMutation.isPending || stopLiveMutation.isPending;
  const importDisabled = importMutation.isPending || data.liveRunning;
  const liveError = (startLiveMutation.error || stopLiveMutation.error) as Error | null;

  const discardEdits = () => {
    setForm(syncForm(data));
    setHasLocalEdits(false);
  };

  const importCompletedAt = data.lastImport?.completedAt ? Date.parse(data.lastImport.completedAt) : 0;
  const liveCompletedAt = data.lastLiveActivity?.completedAt ? Date.parse(data.lastLiveActivity.completedAt) : 0;
  const lastActivity =
    importCompletedAt || liveCompletedAt
      ? liveCompletedAt >= importCompletedAt
        ? data.lastLiveActivity
        : data.lastImport
      : undefined;

  // Unsaved edits are saved before starting live tracking so the poller never
  // silently runs on stale config; a failed save aborts the start.
  const handleLiveToggle = async () => {
    if (data.liveRunning) {
      stopLiveMutation.mutate();
      return;
    }
    if (hasLocalEdits) {
      try {
        await saveMutation.mutateAsync();
      } catch {
        return;
      }
    }
    startLiveMutation.mutate();
  };

  return (
    <div className="stack-lg">
      <section className="panel" aria-label="Runtime status">
        {data.lastError && data.lastError !== dismissedError ? (
          <div className="settings-last-error" role="alert">
            <span>Last runtime error</span>
            <p>{data.lastError}</p>
            <button type="button" onClick={() => setDismissedError(data.lastError ?? "")}>
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="settings-strip">
          <div className="settings-strip-item">
            <span>Live Tracking</span>
            <StatusPill tone={data.liveRunning ? "positive" : "neutral"} pulsing={data.liveRunning}>
              {data.liveRunning ? "Running" : "Stopped"}
            </StatusPill>
          </div>
          <div className="settings-strip-item">
            <span>Active Log</span>
            <StatusPill tone={data.activeLogPathExists ? "positive" : "negative"}>
              {data.activeLogPathExists ? "Found" : "Missing"}
            </StatusPill>
          </div>
          <div className="settings-strip-item">
            <span>Last Activity</span>
            <small>
              {data.liveRunning && data.liveLastTickAt
                ? `Live update ${formatRelativeTime(data.liveLastTickAt)}`
                : lastActivity?.completedAt
                  ? `${lastActivity.kind === "import" ? "Import" : "Live"} ${formatRelativeTime(lastActivity.completedAt)}`
                  : "No activity yet"}
            </small>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Tracking</h3>
          <p>
            {hasLocalEdits ? <span className="settings-unsaved-chip">Unsaved changes</span> : null}
            Where match data is read from and how often. Blank log path uses the default MTGA macOS location.
          </p>
        </div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>
              Custom Log Path
              {form.logPath.trim() ? (
                <button
                  type="button"
                  className="settings-text-button"
                  onClick={(event) => {
                    event.preventDefault();
                    setForm((current) => ({ ...current, logPath: "" }));
                    setHasLocalEdits(true);
                  }}
                >
                  Use default
                </button>
              ) : null}
            </span>
            <input
              className="settings-input"
              type="text"
              value={form.logPath}
              onChange={(event) => {
                setForm((current) => ({ ...current, logPath: event.target.value }));
                setHasLocalEdits(true);
              }}
              placeholder={data.defaultLogPath}
              spellCheck={false}
            />
            <small title={effectiveActivePath}>
              Current effective path: {shortenHomePath(effectiveActivePath)}
            </small>
          </label>

          <label className="settings-field">
            <span>Live Poll Interval</span>
            <select
              className="settings-input"
              value={String(form.pollIntervalSeconds)}
              onChange={(event) => {
                setForm((current) => ({
                  ...current,
                  pollIntervalSeconds: normalizePollInterval(event.target.value),
                }));
                setHasLocalEdits(true);
              }}
            >
              {pollOptions.map((seconds) => (
                <option key={seconds} value={String(seconds)}>
                  {seconds === 1 ? "1 second" : `${seconds} seconds`}
                </option>
              ))}
            </select>
            <small>Lower values update faster but keep the parser busier.</small>
          </label>
        </div>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={form.includePrev}
            onChange={(event) => {
              setForm((current) => ({ ...current, includePrev: event.target.checked }));
              setHasLocalEdits(true);
            }}
            disabled={form.logPath.trim().length > 0}
          />
          <span>
            Include <code>Player-prev.log</code> during full imports when using the default MTGA log location.
          </span>
        </label>
        {form.logPath.trim().length > 0 ? (
          <p className="settings-checkbox-hint">Disabled while a custom log path is set.</p>
        ) : (
          <p className="settings-prevlog">
            Default previous log: <PathValue path={data.previousLogPath || data.defaultPrevLogPath} />{" "}
            <StatusPill tone={data.previousLogPathExists ? "positive" : "negative"}>
              {data.previousLogPathExists ? "Found" : "Missing"}
            </StatusPill>
          </p>
        )}

        <div className="settings-action-row">
          <button
            type="button"
            className={`control-button${hasLocalEdits ? " control-button--primary" : ""}${
              savedFlash ? " is-flash" : ""
            }`}
            onClick={() => saveMutation.mutate()}
            disabled={saveDisabled}
          >
            {saveMutation.isPending ? "Saving…" : savedFlash ? "Saved ✓" : "Save Settings"}
          </button>
          {hasLocalEdits ? (
            <button
              type="button"
              className="control-button control-button--quiet"
              onClick={discardEdits}
              disabled={saveMutation.isPending}
            >
              Discard
            </button>
          ) : null}
          <button
            type="button"
            className={`control-button${
              data.liveRunning ? " control-button--quiet" : hasLocalEdits ? "" : " control-button--primary"
            }`}
            onClick={() => void handleLiveToggle()}
            disabled={liveMutationPending || saveMutation.isPending}
          >
            {liveMutationPending
              ? data.liveRunning
                ? "Stopping…"
                : "Starting…"
              : data.liveRunning
                ? "Stop Live Tracking"
                : "Start Live Tracking"}
          </button>
        </div>

        {saveMutation.error ? (
          <StatusMessage tone="error">Save failed: {(saveMutation.error as Error).message}</StatusMessage>
        ) : null}
        {liveError ? <StatusMessage tone="error">Live tracking: {liveError.message}</StatusMessage> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Data</h3>
          <p>Local database, config file, and import history.</p>
        </div>

        <div className="settings-status-grid">
          <article className="settings-status-card">
            <span>Database</span>
            <PathValue path={data.dbPath} />
          </article>
          <article className="settings-status-card">
            <span>Config File</span>
            <PathValue path={data.configPath} />
            <small title={data.supportDir}>{shortenHomePath(data.supportDir)}</small>
          </article>
          <article className="settings-status-card">
            <span>Last Import</span>
            <strong>{summarizeOperation(data.lastImport)}</strong>
            <small>
              {data.lastImport?.completedAt ? `Completed ${formatDateTime(data.lastImport.completedAt)}` : "No import run yet"}
            </small>
          </article>
          <article className="settings-status-card">
            <span>Last Live Activity</span>
            <strong>{summarizeOperation(data.lastLiveActivity)}</strong>
            <small>
              {data.lastLiveActivity?.completedAt
                ? `Observed ${formatDateTime(data.lastLiveActivity.completedAt)}`
                : "No live activity yet"}
            </small>
          </article>
        </div>

        <div className="settings-action-row">
          <button
            type="button"
            className="control-button"
            onClick={() => importMutation.mutate()}
            disabled={importDisabled}
            title={data.liveRunning ? "Stop live tracking before running a manual import." : undefined}
          >
            {importMutation.isPending ? "Importing…" : "Import Logs Now"}
          </button>
        </div>

        {importMutation.error ? (
          <StatusMessage tone="error">Import failed: {(importMutation.error as Error).message}</StatusMessage>
        ) : null}

        <p className="settings-note">
          Manual import uses resume mode, so an empty database still gets full history and later runs only ingest new data.
          {data.liveRunning ? " Importing is unavailable while live tracking runs." : ""}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Application</h3>
          <p>Appearance, startup behavior, and updates.</p>
        </div>

        <p className="settings-note settings-version">Version {data.version || "unknown"}</p>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={theme === "light"}
            onChange={(event) => setTheme(event.target.checked ? "light" : "dark")}
          />
          <span>Use light theme.</span>
        </label>

        {autostartMutation.error ? (
          <StatusMessage tone="error">{(autostartMutation.error as Error).message}</StatusMessage>
        ) : null}

        {autostartQuery.data?.supported ? (
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={autostartQuery.data.enabled}
              onChange={(event) => autostartMutation.mutate(event.target.checked)}
              disabled={autostartMutation.isPending}
            />
            <span>Launch MTGData at login.</span>
          </label>
        ) : (
          <p className="settings-note">{autostartQuery.data?.note || "Launch at login is unavailable."}</p>
        )}
        {autostartQuery.data?.supported && autostartQuery.data.note ? (
          <p className="settings-note">{autostartQuery.data.note}</p>
        ) : null}

        <div className="settings-action-row">
          <button
            type="button"
            className="control-button"
            onClick={() => updateCheckMutation.mutate()}
            disabled={updateCheckMutation.isPending}
          >
            {updateCheckMutation.isPending ? "Checking…" : "Check for Updates"}
          </button>
        </div>
        {updateCheckMutation.error ? (
          <StatusMessage tone="error">{(updateCheckMutation.error as Error).message}</StatusMessage>
        ) : null}
        {updateCheckMutation.data ? (
          <p className="settings-note">
            {summarizeUpdateCheck(updateCheckMutation.data)}
            {updateCheckMutation.data.updateAvailable && updateCheckMutation.data.releaseUrl ? (
              <>
                {" "}
                <a href={updateCheckMutation.data.releaseUrl} target="_blank" rel="noreferrer">
                  View release
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        <p className="settings-note">
          Closing the window keeps MTGData running in the background so live tracking continues; quit fully with
          Cmd+Q.
        </p>
      </section>
    </div>
  );
}
