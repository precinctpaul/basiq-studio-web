"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatShort } from "@/lib/timecode";
import { agentMediaUrl } from "@/lib/agent";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 350;
const ALL_TAGS = "";

function prettyDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** files.last_write_time is a raw Windows filesystem timestamp string
 *  ("7/10/2026 8:15:55 PM"), not ISO -- Node's Date parser handles that
 *  format fine, but fall back to the raw string rather than "Invalid
 *  Date" if a value ever doesn't parse. */
function prettyCaptureDate(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

interface TagFacet {
  label: string;
  count: number;
}

interface PersonFacet {
  id: string;
  name: string;
  state?: string | null;
  count: number;
}

interface ChamberGroup {
  chamber: string;
  count: number;
  people: PersonFacet[];
}

interface BucketsResponse {
  chambers: ChamberGroup[];
  notableFigures: PersonFacet[];
  institutionalCount: number;
  uncategorizedCount: number;
  totalItems: number;
}

interface ArchiveRow {
  id: string;
  title: string;
  publish_date: string | null;
  capture_date: string | null;
  duration_seconds: number | null;
  source_platform: string;
  source_url: string | null;
  is_institutional: boolean;
  transcript_status: string;
  person: { id: string; full_name: string; chamber: string | null; state: string | null } | null;
  tags: string[];
}

interface ArchiveDetail {
  item: {
    id: string;
    title: string | null;
    description: string | null;
    publish_date: string | null;
    capture_date: string | null;
    duration_seconds: number | null;
    source_platform: string;
    source_url: string | null;
    is_institutional: boolean;
    video_completeness: string | null;
    transcript_status: string;
    transcript_source: string | null;
    transcript_text: string | null;
    person_match_source: string | null;
    person: { full_name: string; chamber: string | null; state: string | null; party: string | null; bioguide_id: string | null } | null;
  };
  files: Array<{ role: string; extension: string | null; size_mb: number | null; quality_guess: string | null; relative_path: string | null }>;
  tags: Array<{ label: string; kind: string | null; source: string }>;
  legislation: Array<{ congress: number; bill_type: string; bill_number: number; title: string | null; display: string | null }>;
}

type ExplorerView =
  | { level: "root" }
  | { level: "chamber"; chamber: string }
  | { level: "notable" }
  | { level: "institutional" }
  | { level: "uncategorized" }
  | { level: "person"; personId: string; personName: string; back: ExplorerView };

function transcriptBadge(status: string) {
  if (status === "available") return <span className="status-ready">TRANSCRIPT</span>;
  if (status === "failed") return <span className="status-error">NO SPEECH</span>;
  return <span className="status-muted">NO TRANSCRIPT</span>;
}

/** Several hundred items have the literal string "Untitled" baked into
 *  their source metadata (a transcript-only ingest pipeline with no title
 *  field at all) -- leading with the person's name when we have one reads
 *  far better than a bare "Untitled" repeated hundreds of times in a row. */
function displayTitle(title: string, person: { full_name: string } | null): string {
  if (title && title !== "Untitled") return title;
  return person ? `${person.full_name} — untitled clip` : "Untitled";
}

const ROW_GRID = "minmax(0,3fr) minmax(0,1.3fr) 90px 90px 60px 90px";

function RowHeader() {
  return (
    <div
      className="status-muted"
      style={{ display: "grid", gridTemplateColumns: ROW_GRID, gap: 10, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}
    >
      <span>TITLE</span>
      <span>PERSON</span>
      <span>PUBLISHED</span>
      <span>CAPTURED</span>
      <span>LENGTH</span>
      <span>SOURCE</span>
    </div>
  );
}

export function ArchivePanel() {
  const [buckets, setBuckets] = useState<BucketsResponse | null>(null);
  const [tags, setTags] = useState<TagFacet[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState(ALL_TAGS);
  const [view, setView] = useState<ExplorerView>({ level: "root" });

  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetch("/api/archive/buckets")
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) setBuckets(data);
      })
      .catch(() => {});
    fetch("/api/archive/facets")
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) setTags(data.tags ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const searchActive = search.length >= 2;
  const itemLevel = searchActive || view.level === "person" || view.level === "institutional" || view.level === "uncategorized";

  const fetchPage = useCallback(
    (pageNum: number) => {
      const params = new URLSearchParams({ page: String(pageNum), limit: String(PAGE_SIZE) });
      if (tag) params.set("tag", tag);
      if (searchActive) {
        params.set("search", search);
      } else if (view.level === "person") {
        params.set("person", view.personId);
      } else if (view.level === "institutional") {
        params.set("bucket", "Institutional");
      } else if (view.level === "uncategorized") {
        params.set("bucket", "Uncategorized");
      }
      return fetch(`/api/archive?${params.toString()}`).then((res) => res.json());
    },
    [tag, search, searchActive, view]
  );

  useEffect(() => {
    if (!itemLevel) {
      setRows([]);
      setTotal(0);
      setHasMore(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPage(0);
    fetchPage(0)
      .then((data) => {
        if (cancelled) return;
        setRows(data.rows ?? []);
        setTotal(data.pagination?.total ?? 0);
        setHasMore(Boolean(data.pagination?.hasMore));
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
        setHasMore(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [itemLevel, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    const next = page + 1;
    setLoading(true);
    fetchPage(next)
      .then((data) => {
        setPage(next);
        setRows((prev) => [...prev, ...(data.rows ?? [])]);
        setHasMore(Boolean(data.pagination?.hasMore));
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoading(false));
  }, [loading, hasMore, page, fetchPage]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 1200) loadMore();
  };

  const selectRow = useCallback((id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    fetch(`/api/archive/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) setDetail(data);
      })
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, []);

  const goBack = useCallback(() => {
    if (view.level === "person") setView(view.back);
    else setView({ level: "root" });
  }, [view]);

  const playableFile = useMemo(
    () => detail?.files.find((f) => f.role === "video" && f.relative_path),
    [detail]
  );

  const renderFolderRow = (key: string, label: string, count: number, onOpen: () => void) => (
    <div key={key} className="playlist-row" onDoubleClick={onOpen} title={`Double-click to open ${label}`} style={{ cursor: "default" }}>
      <span className="playlist-row-title">
        <span>{label}</span>
      </span>
      <span className="playlist-row-duration">{count.toLocaleString()}</span>
    </div>
  );

  const renderExplorerFolders = () => {
    if (!buckets) return <div className="status-muted text-center" style={{ padding: 12 }}>Loading archive…</div>;

    if (view.level === "root") {
      return (
        <>
          {buckets.chambers.map((c) =>
            renderFolderRow(c.chamber, c.chamber, c.count, () => setView({ level: "chamber", chamber: c.chamber }))
          )}
          {renderFolderRow("Notable Figures", "Notable Figures", buckets.notableFigures.reduce((s, p) => s + p.count, 0), () =>
            setView({ level: "notable" })
          )}
          {renderFolderRow("Institutional", "Institutional", buckets.institutionalCount, () => setView({ level: "institutional" }))}
          {renderFolderRow("Uncategorized", "Uncategorized", buckets.uncategorizedCount, () => setView({ level: "uncategorized" }))}
        </>
      );
    }

    if (view.level === "chamber") {
      const c = buckets.chambers.find((x) => x.chamber === view.chamber);
      return (
        <>
          {(c?.people ?? []).map((p) =>
            renderFolderRow(p.id, `${p.name}${p.state ? ` (${p.state})` : ""}`, p.count, () =>
              setView({ level: "person", personId: p.id, personName: p.name, back: view })
            )
          )}
        </>
      );
    }

    if (view.level === "notable") {
      return (
        <>
          {buckets.notableFigures.map((p) =>
            renderFolderRow(p.id, p.name, p.count, () => setView({ level: "person", personId: p.id, personName: p.name, back: view }))
          )}
        </>
      );
    }

    return null;
  };

  const renderItemRow = (row: ArchiveRow) => (
    <div
      key={row.id}
      className="playlist-row"
      data-selected={row.id === selectedId ? "true" : undefined}
      onClick={() => selectRow(row.id)}
      title={row.title}
      style={{ display: "grid", gridTemplateColumns: ROW_GRID, gap: 10, alignItems: "center" }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayTitle(row.title, row.person)}
      </span>
      <span className="status-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {row.person?.full_name ?? (row.is_institutional ? "Institutional" : "—")}
      </span>
      <span className="status-muted">{prettyDate(row.publish_date)}</span>
      <span className="status-muted">{prettyCaptureDate(row.capture_date)}</span>
      <span className="status-muted">{row.duration_seconds ? formatShort(row.duration_seconds) : "—"}</span>
      <span className="status-muted" style={{ textTransform: "uppercase" }}>{row.source_platform}</span>
    </div>
  );

  const headerLabel =
    view.level === "root"
      ? "ARCHIVE"
      : view.level === "chamber"
      ? view.chamber
      : view.level === "notable"
      ? "Notable Figures"
      : view.level === "institutional"
      ? "Institutional"
      : view.level === "uncategorized"
      ? "Uncategorized"
      : view.personName;

  const headerCount = searchActive
    ? total
    : view.level === "root"
    ? buckets?.totalItems ?? 0
    : view.level === "chamber"
    ? buckets?.chambers.find((c) => c.chamber === view.chamber)?.count ?? 0
    : view.level === "notable"
    ? buckets?.notableFigures.reduce((s, p) => s + p.count, 0) ?? 0
    : view.level === "institutional"
    ? buckets?.institutionalCount ?? 0
    : view.level === "uncategorized"
    ? buckets?.uncategorizedCount ?? 0
    : total;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="sidebar flex h-full min-h-0 flex-col" style={{ width: 280, flexShrink: 0, padding: "16px 18px", gap: 10 }}>
        <div className="flex items-center">
          <span className="section-label">{searchActive ? "SEARCH RESULTS" : headerLabel.toUpperCase()}</span>
          <span className="flex-1" />
          <span className="status-muted">{headerCount.toLocaleString()}</span>
        </div>

        <input
          type="text"
          className="field"
          placeholder="Search titles + transcripts…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />

        <select className="select" value={tag} onChange={(e) => setTag(e.target.value)} title="Filter by tag">
          <option value={ALL_TAGS}>All tags</option>
          {tags.map((t) => (
            <option key={t.label} value={t.label}>
              {t.label} ({t.count})
            </option>
          ))}
        </select>

        {!searchActive && view.level !== "root" && (
          <div className="playlist-row" style={{ cursor: "pointer", fontWeight: 600, flexShrink: 0 }} onClick={goBack}>
            <span>◂ &nbsp;{view.level === "person" ? "Back" : "All buckets"}</span>
          </div>
        )}

        <div className="list-surface min-h-0 flex-1 overflow-y-auto">
          {searchActive ? (
            <div className="status-muted" style={{ padding: 12 }}>
              {total.toLocaleString()} match{total === 1 ? "" : "es"} for &ldquo;{search}&rdquo;
            </div>
          ) : (
            !itemLevel && renderExplorerFolders()
          )}
        </div>
      </div>

      <div className="list-surface min-h-0 flex-1 overflow-y-auto" style={{ flexBasis: 640, display: "flex", flexDirection: "column" }} onScroll={handleScroll}>
        {itemLevel && <RowHeader />}
        <div style={{ overflowY: "auto" }}>
          {itemLevel && rows.map(renderItemRow)}
          {itemLevel && loading && rows.length === 0 && (
            <div className="status-muted text-center" style={{ padding: 12 }}>Loading…</div>
          )}
          {itemLevel && !loading && rows.length === 0 && (
            <div className="status-muted text-center" style={{ padding: 12 }}>No matches.</div>
          )}
          {itemLevel && loading && rows.length > 0 && (
            <div className="status-muted text-center" style={{ padding: 12 }}>Loading more…</div>
          )}
          {!itemLevel && !searchActive && (
            <div className="status-muted text-center" style={{ padding: 12 }}>
              Pick a person, Institutional, or Uncategorized from the left to see items here.
            </div>
          )}
        </div>
      </div>

      <div className="panel min-h-0 flex-1 overflow-y-auto" style={{ padding: "16px 20px" }}>
        {!selectedId && <div className="status-muted">Select an item to see its details.</div>}
        {selectedId && detailLoading && <div className="status-muted">Loading…</div>}
        {selectedId && !detailLoading && detail && (
          <div className="flex flex-col" style={{ gap: 14 }}>
            <div>
              <div className="section-label">{displayTitle(detail.item.title || "Untitled", detail.item.person)}</div>
              <div className="status-muted">
                Published {prettyDate(detail.item.publish_date)} · Captured {prettyCaptureDate(detail.item.capture_date)}
                {detail.item.duration_seconds ? ` · ${formatShort(detail.item.duration_seconds)}` : ""}
                {" · "}
                {detail.item.source_platform.toUpperCase()}
                {" · "}
                {transcriptBadge(detail.item.transcript_status)}
              </div>
            </div>

            {playableFile?.relative_path ? (
              <video controls src={agentMediaUrl(playableFile.relative_path)} style={{ width: "100%", background: "#000" }} />
            ) : (
              <div className="status-muted">
                {detail.files.some((f) => f.role === "video")
                  ? "Video file exists but isn't on the shared drive from this view — can't be played here."
                  : "No video file for this item."}
              </div>
            )}

            {detail.item.person && (
              <div>
                <div className="section-label">PERSON</div>
                <div>
                  {detail.item.person.full_name}
                  {detail.item.person.chamber ? ` — ${detail.item.person.chamber}` : ""}
                  {detail.item.person.state ? `, ${detail.item.person.state}` : ""}
                  {detail.item.person.party ? ` (${detail.item.person.party})` : ""}
                </div>
                {detail.item.person.bioguide_id && <div className="status-muted">BioGuideID: {detail.item.person.bioguide_id}</div>}
              </div>
            )}

            {detail.item.source_url && (
              <a href={detail.item.source_url} target="_blank" rel="noreferrer" className="btn" style={{ textAlign: "center", textDecoration: "none" }}>
                OPEN SOURCE
              </a>
            )}

            {detail.item.description && (
              <div>
                <div className="section-label">DESCRIPTION</div>
                <div>{detail.item.description}</div>
              </div>
            )}

            {detail.tags.length > 0 && (
              <div>
                <div className="section-label">TAGS</div>
                <div className="flex flex-wrap" style={{ gap: 6 }}>
                  {detail.tags.map((t) => (
                    <span key={t.label} className="status-muted" style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px" }}>
                      {t.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {detail.legislation.length > 0 && (
              <div>
                <div className="section-label">LINKED LEGISLATION</div>
                {detail.legislation.map((l) => (
                  <div key={`${l.congress}-${l.bill_type}-${l.bill_number}`}>
                    {l.display || `${l.bill_type} ${l.bill_number} (${l.congress}th Congress)`}
                    {l.title ? ` — ${l.title}` : ""}
                  </div>
                ))}
              </div>
            )}

            <div>
              <div className="section-label">FILES</div>
              {detail.files.map((f, i) => (
                <div key={i} className="status-muted">
                  {f.role} · {f.quality_guess ?? "unknown quality"} · {f.extension ?? ""}
                  {f.size_mb ? ` · ${f.size_mb.toFixed(0)} MB` : ""}
                  {!f.relative_path && f.role === "video" ? " · not on shared drive" : ""}
                </div>
              ))}
            </div>

            <div>
              <div className="section-label">TRANSCRIPT</div>
              {detail.item.transcript_text ? (
                <div
                  className="status-muted"
                  style={{ maxHeight: 320, overflowY: "auto", whiteSpace: "pre-wrap", lineHeight: 1.5, padding: 8, border: "1px solid var(--border)", borderRadius: 4 }}
                >
                  {detail.item.transcript_text}
                </div>
              ) : (
                <div className="status-muted">
                  {detail.item.transcript_status === "available"
                    ? "Transcript marked available but text hasn't synced yet."
                    : "No transcript for this item."}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
