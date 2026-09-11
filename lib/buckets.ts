/**
 * Canonical bucket taxonomy, in the order they read best top to bottom.
 * Shared between LibraryPanel (folder ordering), DetailsPanel (the manual
 * bucket-reassignment control), and the bucket API route so all three stay
 * in lockstep with bulk_tag_buckets.py's own seven-bucket taxonomy instead
 * of drifting apart with their own copies of this list.
 */
export const BUCKET_ORDER = [
  "Majority Democrats",
  "The Bench",
  "House",
  "Senate",
  "Notable Figures",
  "Institutional",
] as const;

export const UNCATEGORIZED = "Uncategorized";
