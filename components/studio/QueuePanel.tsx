"use client";

const HEADERS = ["TASK ID", "TYPE", "TARGET", "STATUS", "PROGRESS"] as const;

/** KIND_COLOUR from queue_panel.py — Capture is deliberately absent there and
 *  falls through to milk, so it does the same here. */
const KIND_COLOUR: Record<string, string> = {
  DOWNLOAD: "var(--blue)",
  EXPORT: "var(--red)",
  TRANSCRIBE: "var(--acid)",
  SCAN: "var(--muted)",
};

export interface QueueTask {
  id: string;
  kind: string;
  target: string;
  status: string;
  pct: number | null;
  /** Set while a live capture is running — the handle the STOP button needs. */
  jobId?: string;
  stoppable?: boolean;
}

interface Props {
  tasks: QueueTask[];
  pinned: boolean;
  onTogglePin: () => void;
  onClearFinished: () => void;
  onStop: (task: QueueTask) => void;
}

/** Leading-ellipsis elision, tail kept — a path's useful half is its end. */
function elideTarget(target: string): string {
  return target.length > 90 ? "…" + target.slice(-88) : target;
}

export function QueuePanel({ tasks, pinned, onTogglePin, onClearFinished, onStop }: Props) {
  const active = tasks.filter((t) => t.status !== "Complete" && t.status !== "Error" && t.status !== "Cancelled").length;

  return (
    <div className="flex flex-col">
      {/* Drawer handle — replaces the dock's default title bar */}
      <div className="flex items-center" style={{ padding: "4px 8px 4px 12px", gap: 8 }}>
        <span className="section-label">QUEUE · {active > 0 ? `${active} active` : "idle"}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn-ghost"
          data-checked={pinned ? "true" : undefined}
          onClick={onTogglePin}
          title="Pin the queue drawer open — otherwise it auto-collapses once idle"
        >
          📌 {pinned ? "PINNED" : "PIN"}
        </button>
      </div>

      <div className="panel flex flex-col" style={{ padding: "10px 14px 12px", gap: 8 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="section-label">ACTIVE QUEUES</span>
          <span className="status-muted">
            {tasks.length ? `— ${tasks.length} task(s)` : "— idle"}
          </span>
          <span className="flex-1" />
          <button type="button" className="btn-ghost" onClick={onClearFinished}>
            CLEAR FINISHED
          </button>
        </div>

        <div className="overflow-x-auto">
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 96 }} />
              <col style={{ width: 130 }} />
              <col />
              <col style={{ width: 240 }} />
              <col style={{ width: 150 }} />
            </colgroup>
            <thead>
              <tr>
                {HEADERS.map((h) => (
                  <th key={h} className="queue-header">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const kind = t.kind.toUpperCase();
                return (
                  <tr key={t.id} className="queue-row">
                    <td className="queue-cell" style={{ fontFamily: "var(--font-mono)" }}>
                      {t.id.slice(0, 8)}…
                    </td>
                    <td className="queue-cell" style={{ color: KIND_COLOUR[kind] ?? "var(--milk)" }}>
                      {kind}
                    </td>
                    <td
                      className="queue-cell"
                      title={t.target}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {elideTarget(t.target)}
                    </td>
                    <td
                      className="queue-cell"
                      style={{ color: t.status === "Error" ? "var(--red)" : "var(--milk)" }}
                    >
                      {t.status}
                    </td>
                    <td className="queue-cell">
                      {t.stoppable ? (
                        // A capture has no percentage to show — it has no total
                        // to divide by — so this cell carries the control that
                        // ends it instead. Red, because it is the one button
                        // here that changes what lands on disk.
                        <button
                          type="button"
                          className="btn"
                          style={{
                            background: "var(--red)",
                            color: "#ffffff",
                            padding: "4px 14px",
                            width: "100%",
                          }}
                          onClick={() => onStop(t)}
                          title="Finish the recording and keep it"
                        >
                          STOP
                        </button>
                      ) : t.pct === null ? null : (
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${t.pct}%` }} />
                          {/* Text sits over the whole track, not the fill, and flips
                              colour at 55% so it stays readable on either ground. */}
                          <span
                            className="progress-text"
                            style={{ color: t.pct > 55 ? "var(--ink)" : "var(--milk)" }}
                          >
                            {t.pct.toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
