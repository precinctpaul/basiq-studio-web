"use client";

/**
 * Admin console -- workers (the backup download mesh, tools/mesh.py), the
 * backup queue, cloud route health, and mesh settings. Built to grow: each
 * tab is one entry in TABS with its own component, and everything reads
 * from one /admin/overview snapshot the agent returns, so a new section is
 * a new tab + (optionally) a new field in that snapshot.
 *
 * Visual conventions are the home page's (header bar, tabs, buttons) on
 * purpose -- see app/globals.css "Admin console".
 */
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Worker = {
  id: string; name: string; owner: string; platform: string; version: string; hostname?: string;
  enabled: boolean; draining: boolean; always_on: boolean; revoked: boolean; online: boolean;
  status: "online" | "busy" | "offline" | "off" | "draining" | "revoked"; outdated: boolean;
  last_seen: number; last_ip: string; lucid_ok: boolean | null; free_gb: number | null;
  media_root?: string; current_job: string | null; done: number; failed: number; created: number; notes: string;
};
type Code = { id: string; label: string; created: number; expires: number; uses_left: number;
  used_by: string[]; revoked: boolean; hint: string };
type Job = { jobId: string; url: string; title: string; status: string; route: string; phase?: string;
  claimedBy?: string; completedBy?: string; tried: string[]; cloudTries: number; since?: number; lastReason: string; error: string };
type ProxyHealth = Record<string, Record<string, { ok: number; fail: number; last_ok: number; last_fail: number;
  last_fail_kind: string }>>;
type Overview = { serverVersion: string; now: number; settings: { mesh_enabled: boolean; auto_update: boolean };
  workers: Worker[]; codes: Code[]; jobs: Job[]; proxyHealth: ProxyHealth; benchSeconds: number };

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin/agent/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

function ago(ts: number | undefined, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const STATUS_CLASS: Record<Worker["status"], string> = {
  online: "status-ready", busy: "status-busy", offline: "status-muted", off: "status-muted",
  draining: "status-busy", revoked: "status-error",
};

// ---------------------------------------------------------------- login
function Login({ onDone, configured }: { onDone: () => void; configured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/admin/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (res.ok) onDone();
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error || "Couldn't sign in.");
  };
  return (
    <form onSubmit={submit} className="panel admin-login">
      <span className="section-label">ADMIN SIGN-IN</span>
      {!configured && <p className="status-error">The admin console isn't configured on this server yet.</p>}
      <input className="field" type="password" placeholder="Admin password" value={password}
             onChange={(e) => setPassword(e.target.value)} autoFocus />
      <button className="btn-primary" type="submit" disabled={!password}>SIGN IN</button>
      {error && <p className="status-error">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------- workers tab
function WorkersTab({ ov, act }: { ov: Overview; act: (path: string, body?: unknown, confirmText?: string) => void }) {
  const [label, setLabel] = useState("");
  const [newCode, setNewCode] = useState("");
  const workers = [...ov.workers].sort((a, b) => Number(a.revoked) - Number(b.revoked) || a.name.localeCompare(b.name));
  const makeCode = async () => {
    const r = await api<{ code: string }>("codes", { label: label || "team code", uses: 50, days: 30 });
    setNewCode(r.code);
    setLabel("");
  };
  return (
    <div className="admin-stack">
      <section className="panel admin-section">
        <div className="admin-section-head">
          <span className="section-label">WORKERS</span>
          <span className="hint">
            {ov.workers.filter((w) => w.online && !w.revoked).length} online · routing is automatic: the grabber&apos;s
            own network first, then always-on nodes, then anyone
          </span>
        </div>
        {workers.length === 0 ? (
          <p className="hint">No workers yet. Create an enrollment code below and set up the first one.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr><th>STATUS</th><th>NAME</th><th>OWNER</th><th>MACHINE</th><th>LUCIDLINK</th><th>LAST SEEN</th>
                  <th>DONE / FAILED</th><th>ALWAYS-ON</th><th></th></tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id} data-dim={w.revoked ? "true" : undefined}>
                    <td><span className={STATUS_CLASS[w.status]}>● {w.status.toUpperCase()}</span>
                      {w.current_job && <div className="hint">job {w.current_job.slice(0, 8)}</div>}</td>
                    <td>
                      <button className="admin-link" title="Rename"
                              onClick={() => { const n = prompt("Worker name", w.name); if (n) act(`workers/${w.id}`, { name: n }); }}>
                        {w.name}
                      </button>
                      {w.outdated && <div className="hint">update pending ({w.version} → {ov.serverVersion})</div>}
                    </td>
                    <td>
                      <button className="admin-link" title="Set owner"
                              onClick={() => { const n = prompt("Owner", w.owner); if (n !== null) act(`workers/${w.id}`, { owner: n }); }}>
                        {w.owner || "—"}
                      </button>
                    </td>
                    <td><div>{w.platform || "—"}</div><div className="hint">{w.version || ""} · {w.last_ip}</div></td>
                    <td>{w.lucid_ok === null ? "—" : w.lucid_ok
                      ? <span className="status-ready">connected</span>
                      : <span className="status-error" title="Files will upload over HTTPS instead">not mounted</span>}
                      {w.free_gb != null && <div className="hint">{w.free_gb} GB free</div>}</td>
                    <td>{ago(w.last_seen, ov.now)}</td>
                    <td>{w.done} / {w.failed}</td>
                    <td>
                      <button className="btn-ghost" data-checked={w.always_on ? "true" : undefined} disabled={w.revoked}
                              onClick={() => act(`workers/${w.id}`, { always_on: !w.always_on })}>
                        {w.always_on ? "ALWAYS-ON" : "NORMAL"}
                      </button>
                    </td>
                    <td className="admin-actions">
                      {!w.revoked && (<>
                        <button className="btn" onClick={() => act(`workers/${w.id}`, { enabled: !w.enabled })}>
                          {w.enabled ? "PAUSE" : "RESUME"}</button>
                        <button className="btn" onClick={() => act(`workers/${w.id}`, { draining: !w.draining })}
                                title="Finish the current job, then take no new ones">
                          {w.draining ? "UNDRAIN" : "DRAIN"}</button>
                        <button className="btn" onClick={() => act(`workers/${w.id}/command`, { type: "update" })}>UPDATE</button>
                        <button className="btn" onClick={() => act(`workers/${w.id}/command`, { type: "restart" })}>RESTART</button>
                        <button className="btn admin-danger"
                                onClick={() => act(`workers/${w.id}/revoke`, { uninstall: true },
                                  `Recall "${w.name}"? Its key stops working immediately and it uninstalls itself the next time it checks in.`)}>
                          RECALL</button>
                      </>)}
                      {w.revoked && (
                        <button className="btn" onClick={() => act(`workers/${w.id}/delete`, {}, `Remove "${w.name}" from this list?`)}>
                          REMOVE</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel admin-section">
        <div className="admin-section-head">
          <span className="section-label">ADD A WORKER</span>
          <span className="hint">An enrollment code lets a machine join (50 uses, 30 days). Each machine then gets its own key.</span>
        </div>
        <div className="admin-row">
          <input className="field" placeholder="Label, e.g. “team rollout” or “Paul's old Mac”" value={label}
                 onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 380 }} />
          <button className="btn-primary" onClick={() => void makeCode()}>CREATE CODE</button>
        </div>
        {newCode && (
          <div className="admin-code">
            <div><span className="section-label">CODE</span> <code>{newCode}</code>
              <button className="btn-ghost" onClick={() => void navigator.clipboard.writeText(newCode)}>COPY</button></div>
            <p className="hint">Mac always-on node (in the repo checkout on that Mac):</p>
            <code className="admin-cmd">bash tools/build/mesh/install-mac-node.sh {newCode} &quot;Basiq Mac Node&quot;</code>
            <p className="hint">Shown once — it isn&apos;t stored in readable form.</p>
          </div>
        )}
        {ov.codes.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>LABEL</th><th>CODE</th><th>USES LEFT</th><th>USED BY</th><th>EXPIRES</th><th></th></tr></thead>
              <tbody>
                {ov.codes.map((c) => {
                  const dead = c.revoked || c.expires < ov.now || c.uses_left <= 0;
                  return (
                    <tr key={c.id} data-dim={dead ? "true" : undefined}>
                      <td>{c.label}</td><td>…{c.hint}</td><td>{c.uses_left}</td><td>{c.used_by.length}</td>
                      <td>{c.revoked ? "revoked" : new Date(c.expires * 1000).toLocaleDateString()}</td>
                      <td>{!dead && <button className="btn" onClick={() => act(`codes/${c.id}/revoke`, {})}>REVOKE</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- queue tab
function QueueTab({ ov, act }: { ov: Overview; act: (path: string, body?: unknown, confirmText?: string) => void }) {
  const names = useMemo(() => Object.fromEntries(ov.workers.map((w) => [w.id, w.name])), [ov.workers]);
  const active = ov.jobs.filter((j) => j.status !== "Complete" && j.status !== "Error");
  const recent = ov.jobs.filter((j) => j.status === "Complete" || j.status === "Error").slice(0, 30);
  const rows = (list: Job[]) => list.map((j) => (
    <tr key={j.jobId}>
      <td><span className={j.status === "Complete" ? "status-ready" : j.status === "Error" ? "status-error" : "status-busy"}>
        {j.status}</span>{j.phase && j.route === "mesh" && <div className="hint">{j.phase}</div>}</td>
      <td className="admin-ellipsis" title={j.url}>{j.title || j.url}</td>
      <td>{j.route === "mesh" ? "backup" : "cloud"}
        {(j.claimedBy || j.completedBy) && <div className="hint">via {names[(j.claimedBy || j.completedBy)!] || j.claimedBy || j.completedBy}</div>}</td>
      <td>{j.tried.map((id) => names[id] || id).join(", ") || "—"}<div className="hint">cloud tries: {j.cloudTries}</div></td>
      <td>{ago(j.since, ov.now)}</td>
      <td className="admin-ellipsis" title={j.error || j.lastReason}>
        {j.status === "Error" ? <span className="status-error">{j.error}</span>
          : j.route === "mesh" && j.lastReason ? <span className="hint">cloud was blocked: {j.lastReason}</span> : ""}</td>
      <td className="admin-actions">
        {j.status !== "Complete" && j.status !== "Error" && (<>
          {j.route === "mesh" && j.phase === "queued" &&
            <button className="btn" onClick={() => act(`jobs/${j.jobId}/retry-cloud`, {})}>RETRY CLOUD NOW</button>}
          <button className="btn admin-danger" onClick={() => act(`jobs/${j.jobId}/cancel`, {}, "Cancel this download?")}>CANCEL</button>
        </>)}
      </td>
    </tr>
  ));
  const head = <thead><tr><th>STATUS</th><th>VIDEO</th><th>ROUTE</th><th>TRIED</th><th>SINCE</th><th>NOTES</th><th></th></tr></thead>;
  return (
    <div className="admin-stack">
      <section className="panel admin-section">
        <div className="admin-section-head"><span className="section-label">IN PROGRESS</span>
          <span className="hint">grabs since the agent last restarted; unfinished ones survive restarts</span></div>
        {active.length ? <div className="admin-table-wrap"><table className="admin-table">{head}<tbody>{rows(active)}</tbody></table></div>
          : <p className="hint">Nothing in flight.</p>}
      </section>
      <section className="panel admin-section">
        <div className="admin-section-head"><span className="section-label">RECENT</span></div>
        {recent.length ? <div className="admin-table-wrap"><table className="admin-table">{head}<tbody>{rows(recent)}</tbody></table></div>
          : <p className="hint">No finished grabs yet.</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- cloud tab
function CloudTab({ ov }: { ov: Overview }) {
  const rows = Object.entries(ov.proxyHealth).flatMap(([route, purposes]) =>
    Object.entries(purposes).map(([purpose, h]) => ({ route, purpose, h })));
  return (
    <section className="panel admin-section">
      <div className="admin-section-head"><span className="section-label">CLOUD ROUTES</span>
        <span className="hint">a route that just failed sits out {Math.round(ov.benchSeconds / 60)} min; grabs go to the backup
          mesh when every route is out</span></div>
      {rows.length === 0 ? <p className="hint">No cloud grabs recorded yet.</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>ROUTE</th><th>FOR</th><th>OK</th><th>FAILED</th><th>STATE</th><th>LAST OK</th></tr></thead>
            <tbody>{rows.map(({ route, purpose, h }) => {
              const benched = ov.now - h.last_fail < ov.benchSeconds;
              return (
                <tr key={route + purpose}>
                  <td>{route}</td><td>{purpose}</td><td>{h.ok}</td><td>{h.fail}</td>
                  <td>{benched ? <span className="status-error">sitting out ({h.last_fail_kind}, {ago(h.last_fail, ov.now)})</span>
                    : <span className="status-ready">ok</span>}</td>
                  <td>{ago(h.last_ok, ov.now)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- settings tab
function SettingsTab({ ov, act }: { ov: Overview; act: (path: string, body?: unknown, confirmText?: string) => void }) {
  return (
    <section className="panel admin-section">
      <div className="admin-section-head"><span className="section-label">SETTINGS</span></div>
      <div className="admin-setting">
        <button className="btn-ghost" data-checked={ov.settings.mesh_enabled ? "true" : undefined}
                onClick={() => act("settings", { mesh_enabled: !ov.settings.mesh_enabled },
                  ov.settings.mesh_enabled ? "Turn the backup mesh off? Blocked cloud grabs will fail instead of using workers." : undefined)}>
          {ov.settings.mesh_enabled ? "BACKUP MESH: ON" : "BACKUP MESH: OFF"}</button>
        <span className="hint">Master switch. Off = workers get no jobs and blocked grabs fail like before.</span>
      </div>
      <div className="admin-setting">
        <button className="btn-ghost" data-checked={ov.settings.auto_update ? "true" : undefined}
                onClick={() => act("settings", { auto_update: !ov.settings.auto_update })}>
          {ov.settings.auto_update ? "AUTO-UPDATE: ON" : "AUTO-UPDATE: OFF"}</button>
        <span className="hint">On = idle workers update themselves to the server&apos;s version ({ov.serverVersion || "unknown"}).
          Deploying to the droplet deploys to every worker.</span>
      </div>
    </section>
  );
}

const TABS = [
  { key: "workers", label: "WORKERS", Component: WorkersTab },
  { key: "queue", label: "QUEUE", Component: QueueTab },
  { key: "cloud", label: "CLOUD ROUTES", Component: ({ ov }: { ov: Overview }) => <CloudTab ov={ov} /> },
  { key: "settings", label: "SETTINGS", Component: SettingsTab },
] as const;

// ---------------------------------------------------------------- page
export default function AdminPage() {
  const [session, setSession] = useState<{ configured: boolean; signedIn: boolean } | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("workers");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setOv(await api<Overview>("overview"));
      setError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "Not signed in.") setSession((s) => (s ? { ...s, signedIn: false } : s));
      setError(msg);
    }
  }, []);

  useEffect(() => {
    void fetch("/api/admin/session").then((r) => r.json()).then(setSession);
  }, []);
  useEffect(() => {
    if (!session?.signedIn) return;
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [session?.signedIn, refresh]);

  const act = useCallback((path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    void api(path, body ?? {}).then(refresh).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [refresh]);

  const signOut = async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    setSession((s) => (s ? { ...s, signedIn: false } : s));
    setOv(null);
  };

  const Active = TABS.find((t) => t.key === tab)!.Component;
  return (
    <div className="admin-page">
      <header className="header-bar flex items-center" style={{ padding: "14px 22px", gap: 14 }}>
        <Image src="/brand/wordmark.png" alt="Majority Democrats" height={46} width={150} priority
               className="brand-wordmark" style={{ height: 46, width: "auto" }} />
        <span className="section-label">BASIQ STUDIO HUB</span>
        <span className="section-label" style={{ color: "var(--acid)" }}>ADMIN</span>
        <span style={{ flex: 1 }} />
        <Link href="/" className="btn-ghost">← BACK TO STUDIO</Link>
        {session?.signedIn && <button className="btn-ghost" onClick={() => void signOut()}>SIGN OUT</button>}
      </header>

      {session && !session.signedIn && (
        <Login configured={session.configured} onDone={() => setSession({ configured: true, signedIn: true })} />
      )}

      {session?.signedIn && (
        <main className="admin-main">
          <nav className="admin-tabs">
            {TABS.map((t) => (
              <button key={t.key} className="tab" data-selected={tab === t.key ? "true" : undefined} onClick={() => setTab(t.key)}>
                {t.label}
                {t.key === "queue" && ov && ov.jobs.some((j) => j.route === "mesh" && j.status !== "Complete" && j.status !== "Error")
                  ? " •" : ""}
              </button>
            ))}
          </nav>
          {error && <p className="status-error admin-error">{error}</p>}
          {ov ? <Active ov={ov} act={act} /> : <p className="hint admin-error">Loading…</p>}
        </main>
      )}
    </div>
  );
}
