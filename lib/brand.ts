/**
 * Brand tokens, ported from app/config.py's BRAND dict. Single source of
 * truth so a color can't drift between components — only the subset the web
 * app actually uses so far.
 */
export const BRAND = {
  acid: "#E7EB94",
  red: "#ED2426",
} as const;
