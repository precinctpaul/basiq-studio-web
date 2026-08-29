"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatShort } from "@/lib/timecode";
import { agentMediaUrl } from "@/lib/agent";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 350;
const ALL_PEOPLE = "";
const ALL_TAGS = "";

function prettyDate(iso: string | null): string {
  if (!iso) return "Undated";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

interface PersonFacet {
  id: string;
  full_name: string;
  chamber: string | null;
  state: string | null;
  count: number;
}

interface TagFacet {
  label: string;
  count: number;
}

interface Facets {
  people: PersonFacet[];
  tags: TagFacet[];
  institutionalCount: number;
  uncategorizedCount: number;
  totalItems: number;
}

interface ArchiveRow {
  id: string;
  title: string;
  publish_date: string | null;
  duration_seconds: number | null;
  source_platform: string;
  is_institutional: boolean;
  video_completeness: string | null;
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
    duration_seconds: number | null;
    source_platform: string;
    source_url: string | null;
    is_institutional: boolean;
    video_completeness: string | null;
    transcript_status: string;
    transcript_source: string | null;
    person_match_source: string | null;
    notes: string | null;
    person: { full_name: string; chamber: string | null; state: string | null; party: string | null; bioguide_id: string | null } | null;
  };
  files: Array<{ role: string; extension: string | null; size_mb: number | null; quality_guess: string | null; relative_path: string | null }>;
  tags: Array<{ label: string; kind: string | null; source: string }>;
  legislation: Array<{ congress: number; bill_type: string; bill_number: number; title: string | null; display: string | null }>;
}

function transcriptBadge(status: string) {
  if (status === "available") return <span className="status-ready">TRANSCRIPT</span>;
  if (status === "failed") return <span className="status-error">NO SPEECH</span>;
  return <span className="status-muted">NO TRANSCRIPT</span>;
}

export function ArchivePanel() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [person, setPerson] = useState(ALL_PEOPLE);
  const [tag, setTag] = useState(ALL_TAGS);
  const [institutionalOnly, setInstitutionalOnly] = useState(false);

  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetch("/api/archive/facets")
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) setFacets(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchPage = useCallback(
    (pageNum: number) => {
      const params = new URLSearchParams({ page: String(pageNum), limit: String(PAGE_SIZE) });
      if (search) params.set("search", search);
      if (person) params.set("person", person);
      if (tag) params.set("tag", tag);
      if (institutionalOnly) params.set("institutional", "1");
      return fetch(`/api/archive?${params.toString()}`).then((res) => res.json());
    },
    [search, person, tag, institutionalOnly]
  );

  useEffect(() => {
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
  }, [fetchPage]);

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

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setPerson(ALL_PEOPLE);
    setTag(ALL_TAGS);
    setInstitutionalOnly(false);
  };

  const playableFile = useMemo(
    () => detail?.files.find((f) => f.role === "video" && f.relative_path),
    [detail]
  );

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="sidebar flex h-full min-h-0 flex-col" style={{ width: 300, flexShrink: 0, padding: "16px 18px", gap: 10 }}>
        <div className="flex items-center">
          <span className="section-label">ARCHIVE</span>
          <span className="flex-1" />
          <span className="status-muted">{total.toLocaleString()}</span>
        </div>

        <input
          type="text"
          className="field"
          placeholder="Search titles, descriptions…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />

        <select className="select" value={person} onChange={(e) => setPerson(e.target.value)} title="Filter by person">
          <option value={ALL_PEOPLE}>All people {facets ? `(${facets.people.length})` : ""}</option>
          {facets?.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
              {p.chamber ? ` — ${p.chamber}` : ""} ({p.count})
            </option>
          ))}
        </select>

        <select className="select" value={tag} onChange={(e) => setTag(e.target.value)} title="Filter by tag">
          <option value={ALL_TAGS}>All tags</option>
          {facets?.tags.map((t) => (
            <option key={t.label} value={t.label}>
              {t.label} ({t.count})
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={institutionalOnly}
            onChange={(e) => setInstitutionalOnly(e.target.checked)}
          />
          <span className="status-muted">Institutional only{facets ? ` (${facets.institutionalCount})` : ""}</span>
        </label>

        <button type="button" className="btn" onClick={clearFilters}>
          CLEAR FILTERS
        </button>
      </div>

      <div className="list-surface min-h-0 flex-1 overflow-y-auto" style={{ flexBasis: 420 }} onScroll={handleScroll}>
        {rows.map((row) => (
          <div
            key={row.id}
            className="playlist-row"
            data-selected={row.id === selectedId ? "true" : undefined}
            onClick={() => selectRow(row.id)}
            title={row.title}
          >
            <div className="playlist-row-title">
              <span>{row.title}</span>
              <span className="playlist-row-tags">
                {prettyDate(row.publish_date)}
                {row.person ? ` · ${row.person.full_name}` : row.is_institutional ? " · Institutional" : ""}
                {row.tags.length > 0 ? ` · ${row.tags.slice(0, 4).join(", ")}` : ""}
              </span>
            </div>
            <span className="playlist-row-duration">
              {row.duration_seconds ? formatShort(row.duration_seconds) : ""}
            </span>
          </div>
        ))}
        {loading && rows.length === 0 && (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            Loading archive…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            No matches.
          </div>
        )}
        {loading && rows.length > 0 && (
          <div className="status-muted text-center" style={{ padding: 12 }}>
            Loading more…
          </div>
        )}
      </div>

      <div className="panel min-h-0 flex-1 overflow-y-auto" style={{ padding: "16px 20px" }}>
        {!selectedId && <div className="status-muted">Select an item to see its details.</div>}
        {selectedId && detailLoading && <div className="status-muted">Loading…</div>}
        {selectedId && !detailLoading && detail && (
          <div className="flex flex-col" style={{ gap: 14 }}>
            <div>
              <div className="section-label">{detail.item.title || "Untitled"}</div>
              <div className="status-muted">
                {prettyDate(detail.item.publish_date)}
                {detail.item.duration_seconds ? ` · ${formatShort(detail.item.duration_seconds)}` : ""}
                {" · "}
                {detail.item.source_platform.toUpperCase()}
                {" · "}
                {transcriptBadge(detail.item.transcript_status)}
              </div>
            </div>

            {playableFile?.relative_path ? (
              <video
                controls
                src={agentMediaUrl(playableFile.relative_path)}
                style={{ width: "100%", background: "#000" }}
              />
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
                {detail.item.person.bioguide_id && (
                  <div className="status-muted">BioGuideID: {detail.item.person.bioguide_id}</div>
                )}
              </div>
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

            {detail.item.source_url && (
              <a href={detail.item.source_url} target="_blank" rel="noreferrer" className="btn" style={{ textAlign: "center", textDecoration: "none" }}>
                OPEN SOURCE
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
