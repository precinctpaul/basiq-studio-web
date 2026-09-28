/**
 * Reels (multi-clip timeline -> single exported reel) is being built
 * incrementally on feature/reels-timeline -- see REELS_DESIGN.md for the
 * full design conversation. Off by default, same pattern as
 * LIVE_CAPTURE_ENABLED in tools/basiq_agent.py / components/studio/
 * IngestBar.tsx: the UI pieces can exist in the tree without being live for
 * real users until the feature is actually finished. Flip to true only for
 * local testing while this is still being built.
 */
export const REELS_ENABLED = false;
