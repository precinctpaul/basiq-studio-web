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

/** archive_item_transcripts only stores flat full_text (no per-cue timing --
 *  pushing that would mean ~2.7M rows, a separate heavier job), so there's
 *  no real timestamp to break on the way the Library's synchronized
 *  transcript does. This at least stops it from rendering as one unbroken
 *  wall of text: split into paragraphs every few sentences, breaking at a
 *  sentence boundary rather than an arbitrary character count. */
function paragraphize(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [text];
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    current += sentence;
    if (current.length > 320) {
      paragraphs.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs;
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
  majorityDemocrats: { count: number; people: PersonFacet[] };
  bench: { count: number; people: PersonFacet[] };
  chambers: ChamberGroup[];
  notableFigures: PersonFacet[];
  institutionalCount: number;
  uncategorizedCount: number;
  totalItems: number;
}

interface Snippet {
  snippet: string;
  matchStart: number;
  matchLength: number;
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
  snippet: Snippet | null;
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

type BucketKey = "Majority Democrats" | "The Bench" | "House" | "Senate" | "Notable Figures" | "Institutional" | "Uncategorized";

type ExplorerView =
  | { level: "root" }
  | { level: "group"; bucket: BucketKey }
  | { level: "person"; bucket: BucketKey; personId: string; personName: string };

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

function highlightSnippet(s: Snippet) {
  const before = s.snippet.slice(0, s.matchStart);
  const match = s.snippet.slice(s.matchStart, s.matchStart + s.matchLength);
  const after = s.snippet.slice(s.matchStart + s.matchLength);
  return (
    <>
      {before}
      <mark style={{ background: "var(--acid)", color: "var(--ink)", padding: "0 2px" }}>{match}</mark>
      {after}
    </>
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
  // Root is the bucket-folder list (same shape as Library's own root), so it
  // is never itemLevel -- only drilling into a person, or into one of the
  // two people-less buckets, reaches actual items.
  const itemLevel =
    searchActive ||
    view.level === "person" ||
    (view.level === "group" && (view.bucket === "Institutional" || view.bucket === "Uncategorized"));

  const fetchPage = useCallback(
    (pageNum: number) => {
      const params = new URLSearchParams({ page: String(pageNum), limit: String(PAGE_SIZE) });
      if (tag) params.set("tag", tag);
      if (searchActive) {
        params.set("search", search);
      } else if (view.level === "person") {
        params.set("person", view.personId);
      } else if (view.level === "group") {
        params.set("bucket", view.bucket);
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

  // Single scrolling element -- attach onScroll directly to the div that
  // actually overflows, not a non-scrolling ancestor (an earlier version
  // nested two overflow:auto divs; the OUTER one never scrolled since the
  // inner one absorbed all the overflow, so onScroll here never fired and
  // loadMore() never ran -- infinite scroll silently capped every list at
  // page 1, invisible until testing with a 534-item person turned up
  // "why is it only showing ~30?").
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
    if (view.level === "person") setView({ level: "group", bucket: view.bucket });
    else setView({ level: "root" });
  }, [view]);

  const playableFile = useMemo(() => detail?.files.find((f) => f.role === "video" && f.relative_path), [detail]);

  const BUCKET_ORDER: BucketKey[] = ["Majority Democrats", "The Bench", "House", "Senate", "Notable Figures", "Institutional", "Uncategorized"];

  const bucketCount = (b: BucketKey): number => {
    if (!buckets) return 0;
    if (b === "Majority Democrats") return buckets.majorityDemocrats.count;
    if (b === "The Bench") return buckets.bench.count;
    if (b === "Notable Figures") return buckets.notableFigures.reduce((s, p) => s + p.count, 0);
    if (b === "Institutional") return buckets.institutionalCount;
    if (b === "Uncategorized") return buckets.uncategorizedCount;
    return buckets.chambers.find((c) => c.chamber === b)?.count ?? 0;
  };

  const bucketPeople = (b: BucketKey): PersonFacet[] | null => {
    if (!buckets) return null;
    if (b === "Majority Democrats") return buckets.majorityDemocrats.people;
    if (b === "The Bench") return buckets.bench.people;
    if (b === "Notable Figures") return buckets.notableFigures;
    if (b === "House" || b === "Senate") return buckets.chambers.find((c) => c.chamber === b)?.people ?? [];
    return null; // Institutional / Uncategorized have no sub-people, straight to items
  };

  // Double-click to open, one back-button row rendered outside the scroll
  // container -- same drill-down pattern as LibraryPanel's renderFolderRow,
  // not a single-click always-visible rail.
  const renderFolderRow = (key: string, label: string, count: number, onOpen: () => void) => (
    <div key={key} className="playlist-row" onDoubleClick={onOpen} title={`Double-click to open ${label}`} style={{ cursor: "default" }}>
      <span className="playlist-row-title">
        <span>{label}</span>
      </span>
      <span className="playlist-row-duration">{count.toLocaleString()}</span>
    </div>
  );

  const renderExplorer = () => {
    if (!buckets) {
      return <div className="status-muted text-center" style={{ padding: 14 }}>Loading archive…</div>;
    }
    if (view.level === "root") {
      return (
        <>
          {BUCKET_ORDER.map((b) => renderFolderRow(b, b, bucketCount(b), () => setView({ level: "group", bucket: b })))}
        </>
      );
    }
    if (view.level === "group") {
      const people = bucketPeople(view.bucket);
      if (people) {
        return (
          <>
            {people.map((p) =>
              renderFolderRow(
                p.id,
                `${p.name}${p.state ? ` (${p.state})` : ""}`,
                p.count,
                () => setView({ level: "person", bucket: view.bucket, personId: p.id, personName: p.name })
              )
            )}
            {people.length === 0 && <div className="status-muted" style={{ padding: 14 }}>No one here yet.</div>}
          </>
        );
      }
    }
    return null;
  };

  // Same two-slot shape as LibraryPanel.renderRow: elided title left,
  // duration right. Person/date/source only get folded into the title line
  // when they aren't already implied by where you drilled in from (inside a
  // person's own folder, that's redundant) -- mirrors how Library only
  // prefixes the uploader when the title doesn't already say it.
  const renderItemRow = (row: ArchiveRow) => {
    const showMeta = searchActive || view.level === "group";
    return (
      <div
        key={row.id}
        className="playlist-row"
        data-selected={row.id === selectedId ? "true" : undefined}
        onClick={() => selectRow(row.id)}
        title={row.title}
        style={row.snippet ? { height: "auto", alignItems: "flex-start", padding: "10px 14px" } : undefined}
      >
        <span className="playlist-row-title" style={row.snippet ? { whiteSpace: "normal" } : undefined}>
          <span>{displayTitle(row.title, row.person)}</span>
          {showMeta && (
            <span className="status-muted">
              {" — "}
              {row.person?.full_name ?? (row.is_institutional ? "Institutional" : "Uncategorized")} · {prettyDate(row.publish_date)} · {row.source_platform.toUpperCase()}
            </span>
          )}
          {row.snippet && (
            <div className="status-muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
              {highlightSnippet(row.snippet)}
            </div>
          )}
        </span>
        <span className="playlist-row-duration">{row.duration_seconds ? formatShort(row.duration_seconds) : "—"}</span>
      </div>
    );
  };

  const breadcrumb = searchActive
    ? `Search results`
    : view.level === "root"
    ? "Archive"
    : view.level === "group"
    ? view.bucket
    : view.personName;

  const headerCount = searchActive
    ? total
    : view.level === "root"
    ? buckets?.totalItems ?? 0
    : view.level === "person"
    ? total
    : itemLevel
    ? total
    : bucketCount(view.bucket);

  // One back-button row, computed once and rendered outside the scrollable
  // list -- same as LibraryPanel.explorerBackLabel.
  const explorerBackLabel: string | null = searchActive
    ? null
    : view.level === "group"
    ? "All buckets"
    : view.level === "person"
    ? view.bucket
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Full-width search bar -- the primary interaction for a newsroom
          finding a keyword across transcripts, not a corner input competing
          with folder navigation. */}
      <div className="flex items-center" style={{ padding: "12px 20px", gap: 12, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <input
          type="text"
          className="field"
          style={{ flex: 1, fontSize: "1rem" }}
          placeholder="Search every title and transcript in the archive…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select className="select" value={tag} onChange={(e) => setTag(e.target.value)} title="Filter by tag" style={{ width: 220 }}>
          <option value={ALL_TAGS}>All tags</option>
          {tags.map((t) => (
            <option key={t.label} value={t.label}>
              {t.label} ({t.count})
            </option>
          ))}
        </select>
      </div>

      {/* Single drill-down list -- root shows the 7 buckets, same shape as
          LibraryPanel's folder explorer, instead of a permanent side rail
          duplicating the same navigation. */}
      <div className="flex min-h-0 flex-1">
          <div className="list-surface flex min-h-0 flex-1 flex-col">
            <div className="flex items-center" style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <span className="section-label">{breadcrumb.toUpperCase()}</span>
              <span className="flex-1" />
              <span className="status-muted">{headerCount.toLocaleString()}</span>
            </div>

            {explorerBackLabel && (
              <div className="playlist-row" style={{ cursor: "pointer", fontWeight: 600, flexShrink: 0 }} onClick={goBack}>
                <span>◂ &nbsp;{explorerBackLabel}</span>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto" onScroll={handleScroll}>
              {!itemLevel && renderExplorer()}
              {itemLevel && rows.map(renderItemRow)}
              {itemLevel && loading && rows.length === 0 && (
                <div className="status-muted text-center" style={{ padding: 14 }}>Loading…</div>
              )}
              {itemLevel && !loading && rows.length === 0 && (
                <div className="status-muted text-center" style={{ padding: 14 }}>No matches.</div>
              )}
              {itemLevel && loading && rows.length > 0 && (
                <div className="status-muted text-center" style={{ padding: 14 }}>Loading more…</div>
              )}
            </div>
          </div>

          {/* Detail only takes width once something's actually selected --
              no permanent "select an item" dead zone eating a third of the
              screen while browsing. */}
          {selectedId && (
            <div className="panel flex min-h-0 flex-col" style={{ width: 460, flexShrink: 0 }}>
              {/* Pinned header + video -- stays in view while the rest of the
                  detail (transcript included) scrolls underneath it, same as
                  Library keeping PlayerPanel in its own pane instead of
                  sharing a scroll region with the transcript. */}
              <div style={{ flexShrink: 0, padding: "16px 20px 0" }}>
                <div className="flex items-center" style={{ marginBottom: 10 }}>
                  <span className="flex-1" />
                  <span className="status-muted" style={{ cursor: "pointer" }} onClick={() => setSelectedId(null)}>
                    ✕ Close
                  </span>
                </div>
                {!detailLoading && detail && (
                  <div style={{ marginBottom: 14 }}>
                    <div className="section-label">{displayTitle(detail.item.title || "Untitled", detail.item.person)}</div>
                    <div className="status-muted" style={{ marginBottom: 10 }}>
                      Published {prettyDate(detail.item.publish_date)} · Captured {prettyCaptureDate(detail.item.capture_date)}
                      {detail.item.duration_seconds ? ` · ${formatShort(detail.item.duration_seconds)}` : ""}
                      {" · "}
                      {detail.item.source_platform.toUpperCase()}
                      {" · "}
                      {transcriptBadge(detail.item.transcript_status)}
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
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "0 20px 16px" }}>
              {detailLoading && <div className="status-muted">Loading…</div>}
              {!detailLoading && detail && (
                <div className="flex flex-col" style={{ gap: 14 }}>
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
                      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 4 }}>
                        {paragraphize(detail.item.transcript_text).map((p, i) => (
                          <p key={i} className="status-muted" style={{ lineHeight: 1.6, marginBottom: 12 }}>
                            {p}
                          </p>
                        ))}
                        <div className="status-muted" style={{ fontSize: "0.8em", fontStyle: "italic" }}>
                          No per-line timestamps yet — this is the full transcript broken into readable paragraphs, not synced to the player.
                        </div>
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
          )}
      </div>
    </div>
  );
}
