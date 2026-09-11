"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatTc, humanSize } from "@/lib/timecode";
import { ShareBar } from "@/components/studio/ShareBar";
import { agentDiskLibrary, agentMediaUrl, agentRevealFile, isLocalAgent } from "@/lib/agent";
import { BUCKET_ORDER, UNCATEGORIZED } from "@/lib/buckets";
import rosterData from "@/lib/rosterData.json";

/** Every roster person, sorted for display -- the same data
 *  lib/bucketClassifier.ts matches against, so "assign to a specific
 *  person" here can never name someone the automatic classifier doesn't
 *  also already know about. Built once at module scope, not per-render:
 *  ~600 entries, small enough to ship to the client for this one combobox. */
const ROSTER_PEOPLE: Array<{ display: string; bucket: string }> = Object.values(
  rosterData as Record<string, { display: string; bucket: string }>,
).sort((a, b) => a.display.localeCompare(b.display));

/** Cap on how many roster matches render at once -- typing narrows this
 *  fast, and there's no reason to mount hundreds of DOM rows for an empty
 *  or single-character query. */
const MAX_PERSON_MATCHES = 40;

const EMPTY = "—";

export interface DetailsRow {
  id: string;
  title: string;
  duration_seconds: number;
  size_bytes: number;
  width: number;
  height: number;
  vcodec: string;
  acodec: string;
  fps: number;
  created_at: string;
  uploader?: string | null;
  channel?: string | null;
  upload_date?: string | null;
  source_url?: string | null;
  local_path?: string | null;
  is_clip?: boolean;
  is_live?: boolean;
  has_transcript?: boolean;
  tags?: string[];
  manual_tags?: string[];
}

export interface Tag {
  label: string;
  source: "auto" | "manual";
  kind?: string | null;
}

/** Folder names, in the order they read best top to bottom. */
export const GROUP_LABELS: Record<string, string> = {
  mine: "MY TAGS",
  people: "PEOPLE",
  organizations: "ORGANIZATIONS",
  places: "PLACES",
  events: "EVENTS",
  policy: "POLICY & LAW",
  topics: "TOPICS",
  source: "SOURCE",
};
const GROUP_ORDER = Object.keys(GROUP_LABELS);

/**
 * Bucket tags into their folders.
 *
 * Manual tags always land in "MY TAGS" regardless of what kind they'd
 * otherwise be — an operator's own tags are the ones they came to find, and
 * scattering them through five folders buries them.
 */
export function groupTags(tags: Tag[]): Array<[string, Tag[]]> {
  const buckets = new Map<string, Tag[]>();
  for (const tag of tags) {
    const group = tag.source === "manual" ? "mine" : (tag.kind ?? "topics");
    const list = buckets.get(group) ?? [];
    list.push(tag);
    buckets.set(group, list);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      const ai = GROUP_ORDER.indexOf(a);
      const bi = GROUP_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    })
    .map(([g, list]) => [g, list.sort((x, y) => x.label.localeCompare(y.label))] as [string, Tag[]]);
}

interface Props {
  row: DetailsRow | null;
  emptyMessage: string;
  /** Present when the selected row is a rendered clip that has a live share token. */
  share?: { url: string; downloadCount: number } | null;
  tags?: Tag[];
  onAddTag?: (label: string) => void;
  onRemoveTag?: (label: string) => void;
  onRetag?: () => void;
  retagging?: boolean;
  /** Manually assign/correct this video's bucket, optionally down to a
   *  specific roster person -- the only way to fix one the automatic
   *  classifier (lib/bucketClassifier.ts) got wrong or couldn't reach at
   *  all, e.g. an aggregator repost with no usable uploader/channel/title
   *  and nobody named on camera either. `person`, when present, is a
   *  roster display name (its bucket is derived server-side from the
   *  roster, not from `bucket` here -- see the API route). */
  onBucketChange?: (bucket: string, person?: string) => void;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Port of pretty_upload_date — "20260814" -> "14 Aug 2026". */
function prettyUploadDate(raw?: string | null): string {
  if (!raw) return EMPTY;
  if (!/^\d{8}$/.test(raw)) return raw;
  const y = raw.slice(0, 4);
  const m = Number(raw.slice(4, 6));
  const d = raw.slice(6, 8);
  return `${d} ${MONTHS[m - 1] ?? "?"} ${y}`;
}

/** local_path is always POSIX-style ("/" separators -- see scan_media's
 *  path.relative_to(root).as_posix() in basiq_agent.py); the agent's real
 *  root is a native OS path, backslashes on the Windows machines this runs
 *  on. Joining the two naively left a mixed "C:\...\folder/file.mp4" path --
 *  technically openable in Explorer's address bar, but not what an operator
 *  expects to see on their own clipboard. */
function joinNativePath(root: string, relPath: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const rel = sep === "\\" ? relPath.replace(/\//g, "\\") : relPath;
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return `${base}${sep}${rel}`;
}

function formatModified(iso: string): string {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY;
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // Two spaces between date and time, matching "%d %b %Y  %H:%M".
  return `${day} ${MONTHS[d.getMonth()]} ${d.getFullYear()}  ${hh}:${mm}`;
}

export function DetailsPanel({
  row,
  emptyMessage,
  share,
  tags = [],
  onAddTag,
  onRemoveTag,
  onRetag,
  retagging = false,
  onBucketChange,
}: Props) {
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState("");
  // getAgentUrl() reads localStorage -- resolved client-side only, after
  // mount, so this starts false (hiding COPY PATH/OPEN FILE LOCATION) rather
  // than assuming local and risking a flash of buttons that do nothing
  // useful pointed at a shared cloud agent (see lib/agent.ts's isLocalAgent).
  const [localAgent, setLocalAgent] = useState(false);
  useEffect(() => {
    setLocalAgent(isLocalAgent());
  }, []);

  // The classifier's bucket/person tags (kind="bucket"/"person") are what the
  // dedicated BUCKET combobox below reads and writes -- excluded from the
  // generic tag list further down so they aren't ALSO shown there as plain
  // removable "MY TAGS" chips (both sides write the same rows, via two
  // different UIs, otherwise).
  const currentBucket = tags.find((t) => t.kind === "bucket")?.label ?? UNCATEGORIZED;
  const currentPerson = tags.find((t) => t.kind === "person")?.label;
  const displayTags = tags.filter((t) => t.kind !== "bucket" && t.kind !== "person");

  const [bucketPanelOpen, setBucketPanelOpen] = useState(false);
  const [bucketQuery, setBucketQuery] = useState("");
  const bucketPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bucketPanelOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (bucketPanelRef.current && !bucketPanelRef.current.contains(e.target as Node)) {
        setBucketPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [bucketPanelOpen]);

  const personMatches = useMemo(() => {
    const q = bucketQuery.trim().toLowerCase();
    if (!q) return [];
    return ROSTER_PEOPLE.filter((p) => p.display.toLowerCase().includes(q)).slice(0, MAX_PERSON_MATCHES);
  }, [bucketQuery]);

  const pickBucket = (bucket: string) => {
    onBucketChange?.(bucket);
    setBucketPanelOpen(false);
    setBucketQuery("");
  };
  const pickPerson = (person: { display: string; bucket: string }) => {
    onBucketChange?.(person.bucket, person.display);
    setBucketPanelOpen(false);
    setBucketQuery("");
  };

  // Every field always occupies its row even when empty — deliberate in the
  // original, so the panel never reflows as probe results land.
  const fields: Array<[string, string]> = [
    ["TITLE", row ? row.title || EMPTY : emptyMessage],
    ["KIND", row ? (row.is_clip ? "Clip" : row.is_live ? "Live capture" : "Download") : EMPTY],
    ["DURATION", row?.duration_seconds ? formatTc(row.duration_seconds, 0) : EMPTY],
    ["SIZE", row?.size_bytes ? humanSize(row.size_bytes) : EMPTY],
    ["MODIFIED", row ? formatModified(row.created_at) : EMPTY],
    ["UPLOADER", row?.uploader || EMPTY],
    ["CHANNEL", row?.channel || EMPTY],
    ["PUBLISHED", prettyUploadDate(row?.upload_date)],
    [
      "RESOLUTION",
      row?.width && row?.height
        ? `${row.width}x${row.height}${row.height > row.width ? "  (vertical)" : ""}`
        : EMPTY,
    ],
    ["VIDEO", row?.vcodec ? `${row.vcodec}${row.fps ? `  ·  ${row.fps} fps` : ""}` : EMPTY],
    ["AUDIO", row ? row.acodec || "none" : EMPTY],
    ["TRANSCRIPT", row ? (row.has_transcript ? "AI transcript" : "none yet") : EMPTY],
  ];

  return (
    <div className="panel flex h-full min-h-0 flex-col" style={{ padding: "16px 18px", gap: 12 }}>
      <div className="flex items-center">
        <span className="section-label">MEDIA DETAILS</span>
        <span className="flex-1" />
        <span className="status-muted" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingRight: 6 }}>
        <div
          className="grid"
          style={{ gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 8, alignItems: "start" }}
        >
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <span className="detail-key">{key}</span>
              <span className="detail-value" style={{ wordBreak: "break-word" }}>
                {value}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-start" style={{ gap: 12, marginTop: 10 }}>
          <span className="detail-key">SOURCE</span>
          {row?.source_url ? (
            <a
              className="detail-value"
              href={row.source_url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--blue)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {row.source_url}
            </a>
          ) : (
            <span className="detail-value">{EMPTY}</span>
          )}
        </div>

        <div className="flex items-center" style={{ gap: 12, marginTop: 10 }}>
          <span className="detail-key">BUCKET</span>
          {onBucketChange ? (
            <div ref={bucketPanelRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="select"
                disabled={!row}
                onClick={() => setBucketPanelOpen((v) => !v)}
                title="Manually assign or correct which folder (and optionally which person) this video lives under"
              >
                {currentPerson ? `${currentPerson} (${currentBucket})` : currentBucket}
              </button>
              {bucketPanelOpen && (
                <div
                  className="panel"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    zIndex: 20,
                    width: 280,
                    maxHeight: 360,
                    overflowY: "auto",
                    padding: 10,
                  }}
                >
                  <input
                    type="text"
                    className="field"
                    placeholder="Type to find a specific person…"
                    value={bucketQuery}
                    onChange={(e) => setBucketQuery(e.target.value)}
                    style={{ marginBottom: 8, width: "100%" }}
                    autoFocus
                  />
                  {!bucketQuery && (
                    <>
                      <p className="status-muted" style={{ padding: "2px 4px" }}>
                        Buckets
                      </p>
                      <label
                        className="flex items-center"
                        style={{ gap: 8, padding: "4px 2px", cursor: "pointer" }}
                        onClick={() => pickBucket(UNCATEGORIZED)}
                      >
                        <span className="flex-1">{UNCATEGORIZED}</span>
                      </label>
                      {BUCKET_ORDER.map((b) => (
                        <label
                          key={b}
                          className="flex items-center"
                          style={{ gap: 8, padding: "4px 2px", cursor: "pointer" }}
                          onClick={() => pickBucket(b)}
                        >
                          <span className="flex-1">{b}</span>
                        </label>
                      ))}
                    </>
                  )}
                  {bucketQuery && (
                    <>
                      <p className="status-muted" style={{ padding: "2px 4px" }}>
                        People {personMatches.length >= MAX_PERSON_MATCHES ? `(first ${MAX_PERSON_MATCHES})` : ""}
                      </p>
                      {personMatches.length === 0 && (
                        <p className="status-muted" style={{ padding: 4 }}>
                          No one matches “{bucketQuery}”.
                        </p>
                      )}
                      {personMatches.map((p) => (
                        <label
                          key={p.display}
                          className="flex items-center"
                          style={{ gap: 8, padding: "4px 2px", cursor: "pointer" }}
                          onClick={() => pickPerson(p)}
                        >
                          <span className="flex-1">{p.display}</span>
                          <span className="status-muted">{p.bucket}</span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <span className="detail-value">{row ? (currentPerson ? `${currentPerson} (${currentBucket})` : currentBucket) : EMPTY}</span>
          )}
        </div>

        <div className="detail-path" style={{ marginTop: 10 }}>
          {row?.local_path ?? ""}
        </div>

        {/* Works everywhere, local agent or shared cloud agent alike -- a
            plain HTTPS file transfer through the browser, not a filesystem
            action, so it's the one way anyone (not just an operator running
            their own local agent) actually gets the file itself onto their
            own computer to repost or edit. */}
        <div className="flex" style={{ gap: 8, marginTop: 12 }}>
          <a
            className="btn-path"
            aria-disabled={!row?.local_path}
            href={row?.local_path ? agentMediaUrl(row.local_path, { download: true }) : undefined}
            title="Download this file to your computer"
            style={!row?.local_path ? { pointerEvents: "none", opacity: 0.5 } : undefined}
          >
            DOWNLOAD
          </a>
          <span className="flex-1" />
        </div>

        {/* COPY PATH and OPEN FILE LOCATION only make sense against a LOCAL
            agent -- they act on the operator's own filesystem. Most people
            opening this site talk to the shared cloud agent instead (see
            lib/agent.ts's isLocalAgent), which has no access to or
            knowledge of this browser's own machine: COPY PATH would copy
            the CLOUD agent's own server path (useless pasted into this
            operator's Explorer/Finder), and OPEN FILE LOCATION would ask a
            headless server with no desktop to open one, silently doing
            nothing. Hiding both entirely beats letting them run and
            mislead. */}
        {localAgent && (
        <div className="flex flex-col" style={{ gap: 6, marginTop: 12 }}>
          <div className="flex" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-path"
              disabled={!row?.local_path}
              title="Copy the full shared-drive path to the clipboard"
              onClick={async () => {
                const localPath = row?.local_path;
                if (!localPath) return;
                // local_path is relative to MEDIA_ROOT — usually just a bare
                // filename with no folder — so copying it alone gives no way
                // to actually find the file. Prefixing the agent's own real
                // root (a live call to the local agent's /library, distinct
                // from the DB-backed listing the rest of the app uses) turns
                // this into a real path an operator can paste straight into
                // Explorer/Finder.
                let full = localPath;
                try {
                  const lib = await agentDiskLibrary();
                  if (lib.exists && lib.root) full = joinNativePath(lib.root, localPath);
                } catch {
                  // Agent unreachable — the bare relative path is still
                  // better than nothing on the clipboard.
                }
                await navigator.clipboard.writeText(full);
              }}
            >
              COPY PATH
            </button>
            <button
              type="button"
              className="btn-path"
              disabled={!row?.local_path || revealing}
              title="Open Explorer/Finder with this file selected"
              onClick={async () => {
                const localPath = row?.local_path;
                if (!localPath) return;
                setRevealing(true);
                setRevealError("");
                try {
                  await agentRevealFile(localPath);
                } catch (err) {
                  setRevealError(err instanceof Error ? err.message : String(err));
                } finally {
                  setRevealing(false);
                }
              }}
            >
              {revealing ? "OPENING…" : "OPEN FILE LOCATION"}
            </button>
            <span className="flex-1" />
          </div>
          {revealError && <span className="hint">{revealError}</span>}
        </div>
        )}

        {share && (
          <div style={{ marginTop: 16 }}>
            <ShareBar
              key={share.url}
              url={share.url}
              downloadCount={share.downloadCount}
              variant="inline"
            />
          </div>
        )}

      <div className="flex flex-col" style={{ gap: 8, marginTop: 16 }}>
        <div className="flex items-center" style={{ gap: 10 }}>
          <span className="section-label">TAGS</span>
          <span className="flex-1" />
          {onRetag && (
            <button
              type="button"
              className="btn-ghost"
              onClick={onRetag}
              disabled={!row || retagging}
              title="Re-read the transcript and rebuild the automatic tags"
            >
              {retagging ? "TAGGING…" : "AUTO-TAG"}
            </button>
          )}
        </div>

        {displayTags.length === 0 && <span className="hint">No tags yet.</span>}

        {/* Grouped into folders rather than one long alphabetical run — a
            14-tag list of mixed people, places and topics is a wall. Manual
            tags lead, because they are the operator's own. */}
        {groupTags(displayTags).map(([group, groupTags_]) => (
          <div key={group} className="tag-group">
            <button
              type="button"
              className="tag-group-head"
              onClick={() =>
                setCollapsed((c) => ({ ...c, [group]: !c[group] }))
              }
              title={collapsed[group] ? "Show these tags" : "Hide these tags"}
            >
              <span className="tag-group-caret">{collapsed[group] ? "▸" : "▾"}</span>
              {GROUP_LABELS[group] ?? group}
              <span className="tag-group-count">{groupTags_.length}</span>
            </button>
            {!collapsed[group] && (
              <div className="flex flex-wrap" style={{ gap: 6, paddingTop: 4 }}>
                {groupTags_.map((t) =>
                  t.source === "manual" ? (
                    // Acid, and red on hover — the hover telegraphs the
                    // delete before it happens.
                    <button
                      key={t.label}
                      type="button"
                      className="tag-chip-manual"
                      title="Click to remove"
                      onClick={() => onRemoveTag?.(t.label)}
                    >
                      {t.label}
                      {"  "}✕
                    </button>
                  ) : (
                    // A label, deliberately not a disabled button, so an
                    // automatic tag can never read as clickable.
                    <span
                      key={t.label}
                      className="tag-chip-auto"
                      title="Derived automatically — rebuilt when you auto-tag again."
                    >
                      {t.label}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        ))}

        <input
          type="text"
          className="field"
          placeholder="Add a tag…"
          disabled={!row}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const value = draft.trim();
            if (!value) return;
            setDraft("");
            onAddTag?.(value);
          }}
        />
        <span className="hint">
          Your tags survive every re-tag{"  ·  "}grey tags are derived from the transcript and
          refresh themselves
        </span>
      </div>
      </div>
    </div>
  );
}
