import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { StatusMessage } from "../components/StatusMessage";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { RuntimeConfig, RuntimeOperation, RuntimeStatus } from "../lib/types";

const runtimeStatusKey = ["runtime-status"] as const;

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

  useEffect(() => {
    if (!data || hasLocalEdits) {
      return;
    }
    setForm(syncForm(data));
  }, [data, hasLocalEdits]);

  const saveMutation = useMutation({
    mutationFn: () => api.saveRuntimeConfig(form),
    onSuccess: (status) => {
      queryClient.setQueryData(runtimeStatusKey, status);
      setForm(syncForm(status));
      setHasLocalEdits(false);
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

  const currentError = useMemo(() => {
    return (
      (saveMutation.error as Error | null)?.message ||
      (importMutation.error as Error | null)?.message ||
      (startLiveMutation.error as Error | null)?.message ||
      (stopLiveMutation.error as Error | null)?.message ||
      data?.lastError ||
      ""
    );
  }, [
    data?.lastError,
    importMutation.error,
    saveMutation.error,
    startLiveMutation.error,
    stopLiveMutation.error,
  ]);

  if (isLoading) return <StatusMessage>Loading runtime settings…</StatusMessage>;
  if (error) return <StatusMessage tone="error">{(error as Error).message}</StatusMessage>;
  if (!data) return <StatusMessage>No runtime status available.</StatusMessage>;

  const effectiveActivePath = form.logPath.trim() || data.defaultLogPath;
  const saveDisabled = saveMutation.isPending || !hasLocalEdits;
  const liveMutationPending = startLiveMutation.isPending || stopLiveMutation.isPending;
  const importDisabled = importMutation.isPending || data.liveRunning;

  return (
    <div className="stack-lg">
      <section className="panel">
        <div className="panel-head">
          <h3>Runtime Control</h3>
          <p>{data.liveRunning ? "Live tracking active" : "Manual sync mode"}</p>
        </div>

        {currentError ? <StatusMessage tone="error">{currentError}</StatusMessage> : null}

        <div className="settings-status-grid" aria-label="Runtime status">
          <article className="settings-status-card">
            <span>Database</span>
            <strong>{data.dbPath}</strong>
          </article>
          <article className="settings-status-card">
            <span>Active Log</span>
            <strong>{data.activeLogPath}</strong>
            <small>{data.activeLogPathExists ? "Found" : "Missing"}</small>
          </article>
          <article className="settings-status-card">
            <span>Live State</span>
            <strong>{data.liveRunning ? "Running" : "Stopped"}</strong>
            <small>{data.liveLastTickAt ? `Last tick ${formatDateTime(data.liveLastTickAt)}` : "No ticks yet"}</small>
          </article>
          <article className="settings-status-card">
            <span>Config File</span>
            <strong>{data.configPath}</strong>
            <small>{data.supportDir}</small>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Tracking Settings</h3>
          <p>Blank log path uses the default MTGA macOS location.</p>
        </div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>Custom Log Path</span>
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
            <small>Current effective path: {effectiveActivePath}</small>
          </label>

          <label className="settings-field">
            <span>Live Poll Interval (seconds)</span>
            <input
              className="settings-input"
              type="number"
              min={1}
              step={1}
              value={String(form.pollIntervalSeconds)}
              onChange={(event) => {
                setForm((current) => ({
                  ...current,
                  pollIntervalSeconds: normalizePollInterval(event.target.value),
                }));
                setHasLocalEdits(true);
              }}
            />
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
          <span>Include `Player-prev.log` during full imports when using the default MTGA log location.</span>
        </label>

        <div className="settings-action-row">
          <button
            type="button"
            className="control-button"
            onClick={() => saveMutation.mutate()}
            disabled={saveDisabled}
          >
            {saveMutation.isPending ? "Saving…" : "Save Settings"}
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => importMutation.mutate()}
            disabled={importDisabled}
          >
            {importMutation.isPending ? "Importing…" : "Import Logs Now"}
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => (data.liveRunning ? stopLiveMutation.mutate() : startLiveMutation.mutate())}
            disabled={liveMutationPending}
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

        <p className="settings-note">
          Manual import uses resume mode, so an empty database still gets full history and later runs only ingest new data.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Recent Activity</h3>
          <p>Import and live parser summaries.</p>
        </div>

        <div className="settings-status-grid">
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
          <article className="settings-status-card">
            <span>Default Previous Log</span>
            <strong>{data.previousLogPath || data.defaultPrevLogPath}</strong>
            <small>{data.previousLogPathExists ? "Found" : "Missing"}</small>
          </article>
        </div>
      </section>
    </div>
  );
}
