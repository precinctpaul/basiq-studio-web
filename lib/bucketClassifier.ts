import rosterData from "./rosterData.json";

/**
 * Classifies a freshly-grabbed video's uploader/channel against the same
 * roster tools/bulk_tag_buckets.py uses, so a new grab lands in the right
 * bucket/person folder the instant its metadata is known, instead of
 * sitting in Uncategorized until someone next runs that script by hand.
 *
 * This is a live, in-process port of bulk_tag_buckets.py's MATCHING logic
 * (name_matches + the surname fallback) -- not a reimplementation of the
 * roster itself or the bucket-priority rules. Both of those stay defined
 * in exactly one place (Python): lib/rosterData.json is a static export
 * (tools/export_roster_for_web.py) of bulk_tag_buckets.py's own roster,
 * each person already resolved to their single bucket via
 * pick_primary_membership(). Keeping the matching algorithm identical
 * between the live per-grab path and the offline batch script means a
 * video classifies the same way regardless of which one touches it first.
 */

interface RosterEntry {
  display: string;
  bucket: string;
}

const ROSTER = rosterData as Record<string, RosterEntry>;

let surnameIndex: Map<string, string[]> | null = null;

function buildSurnameIndex(): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const normName of Object.keys(ROSTER)) {
    const words = normName.split(" ");
    const surname = words[words.length - 1];
    if (!surname) continue;
    const list = idx.get(surname) ?? [];
    list.push(normName);
    idx.set(surname, list);
  }
  return idx;
}

function getSurnameIndex(): Map<string, string[]> {
  if (!surnameIndex) surnameIndex = buildSurnameIndex();
  return surnameIndex;
}

const TITLE_PREFIX_RE = /^(rep\.?|sen\.?|senator|representative|congressman|congresswoman|gov\.?|governor|mayor)\s+/i;

function normalizeName(name: string | null | undefined): string {
  let n = (name ?? "").trim();
  n = n.replace(TITLE_PREFIX_RE, "");
  // Periods/commas carry no matching-relevant information in a person's
  // name, but their mere presence broke matching outright: a roster name
  // like "Robert F. Kennedy, Jr." normalized to word set {"f.", "kennedy,",
  // "jr."}, which real-world uploader/channel/title text almost never
  // reproduces exactly. Mirrors bulk_tag_buckets.py's normalize_name.
  n = n.replace(/[.,]/g, "");
  n = n.replace(/\s+/g, " ");
  return n.toLowerCase().trim();
}

/** a and b are already normalized. The shorter name's words must be a full
 *  subset of the longer's, with at least a real first+last overlap -- not
 *  just any single shared word. Identical to bulk_tag_buckets.py's
 *  name_matches(). */
function nameMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));
  const [shorter, longer] = aWords.size <= bWords.size ? [aWords, bWords] : [bWords, aWords];
  if (shorter.size < 2) return false;
  for (const w of shorter) if (!longer.has(w)) return false;
  return true;
}

function findMatches(fields: Array<string | null | undefined>): Map<string, RosterEntry> {
  const matched = new Map<string, RosterEntry>();
  for (const field of fields) {
    const normField = normalizeName(field);
    if (!normField) continue;
    for (const [rosterName, entry] of Object.entries(ROSTER)) {
      if (matched.has(rosterName)) continue;
      if (nameMatches(normField, rosterName)) matched.set(rosterName, entry);
    }
  }
  return matched;
}

/** Second-pass matcher for campaign/office channels branded with only a
 *  surname ("Rep. Auchincloss", "Mahan for California") -- text the strict
 *  pass can never match. A surname shared by more than one roster entry is
 *  deliberately left unmatched rather than guessed, identical to
 *  bulk_tag_buckets.py's find_surname_fallback(). */
function findSurnameFallback(fields: Array<string | null | undefined>): Map<string, RosterEntry> {
  const matched = new Map<string, RosterEntry>();
  const index = getSurnameIndex();
  for (const field of fields) {
    const normField = normalizeName(field);
    if (!normField) continue;
    const candidates = new Set<string>();
    for (const word of normField.split(" ")) {
      const names = index.get(word);
      if (names) for (const n of names) candidates.add(n);
    }
    if (candidates.size === 1) {
      const rosterName = candidates.values().next().value!;
      matched.set(rosterName, ROSTER[rosterName]);
    }
    // 2+ candidates: ambiguous surname, left unmatched on purpose.
  }
  return matched;
}

// Hand-curated map of a real, observed nickname/initialism to the roster
// key it should resolve to -- mirrors bulk_tag_buckets.py's
// FIELD_TEXT_ALIASES exactly (keys are post-normalizeName, i.e. no
// periods/commas). Checked before the surname fallback so it bypasses any
// surname-ambiguity check: "RFK Jr" never spells out "Kennedy" as a word,
// and "Kennedy" alone is ambiguous among four different roster members
// anyway, so even a spelled-out surname wouldn't resolve to him uniquely.
// Deliberately not a general nickname-guessing system -- add one entry at
// a time as a real video surfaces one.
const FIELD_TEXT_ALIASES: Record<string, string> = {
  "rfk jr": "robert f kennedy jr",
};

function findAliasMatches(fields: Array<string | null | undefined>): Map<string, RosterEntry> {
  const matched = new Map<string, RosterEntry>();
  for (const field of fields) {
    const text = normalizeName(field);
    if (!text) continue;
    for (const [alias, rosterName] of Object.entries(FIELD_TEXT_ALIASES)) {
      if (text.includes(alias) && ROSTER[rosterName]) matched.set(rosterName, ROSTER[rosterName]);
    }
  }
  return matched;
}

// Same regex bulk_tag_buckets.py / archive_consolidation's
// enrich_institutional_flag.py use for the identical judgment call.
const INSTITUTIONAL_PATTERNS =
  /(House Session|Senate Session|Morning Hour|Daily Briefing|Cabinet Meeting|News Conference|Press Briefing|Speaks to Reporters|Republican Agenda|Democratic Agenda|Weekly Briefing|Pen and Pad)/i;

export interface ClassificationResult {
  /** One tag row per matched person, e.g. [{label: "Matt Mahan", kind: "person"}, {label: "Majority Democrats", kind: "bucket"}] */
  tags: Array<{ label: string; kind: "person" | "bucket" }>;
}

/**
 * Classifies a video from its uploader/channel (matched against the
 * roster) and, failing that, its title (matched against the institutional
 * pattern). Returns the tag rows to upsert -- empty if neither matches,
 * which leaves the video Uncategorized, same as bulk_tag_buckets.py.
 */
export function classifyVideo(fields: {
  uploader?: string | null;
  channel?: string | null;
  title?: string | null;
}): ClassificationResult {
  const nameFields = [fields.uploader, fields.channel];
  let matches = findMatches(nameFields);
  if (matches.size === 0) matches = findAliasMatches(nameFields);
  if (matches.size === 0) matches = findSurnameFallback(nameFields);

  // uploader/channel carried no roster person at all -- for a lot of
  // aggregator/news accounts (C-SPAN, a journalist's X handle, an Instagram
  // news page) the subject's name never appears in either field, only in
  // the title itself ("President Trump Announces...", "Rep. Auchincloss
  // holds..."). Some C-SPAN clips report a blank uploader/channel outright,
  // same result. Mirrors bulk_tag_buckets.py's title-fallback pass.
  if (matches.size === 0 && fields.title) {
    const titleFields = [fields.title];
    matches = findMatches(titleFields);
    if (matches.size === 0) matches = findAliasMatches(titleFields);
    if (matches.size === 0) matches = findSurnameFallback(titleFields);
  }

  if (matches.size > 0) {
    const tags: ClassificationResult["tags"] = [];
    const buckets = new Set<string>();
    for (const entry of matches.values()) {
      tags.push({ label: entry.display, kind: "person" });
      buckets.add(entry.bucket);
    }
    for (const bucket of buckets) tags.push({ label: bucket, kind: "bucket" });
    return { tags };
  }

  if (fields.title && INSTITUTIONAL_PATTERNS.test(fields.title)) {
    return { tags: [{ label: "Institutional", kind: "bucket" }] };
  }

  return { tags: [] };
}
