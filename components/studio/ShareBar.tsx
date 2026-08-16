"use client";

import { useState } from "react";

interface Props {
  url: string;
  downloadCount?: number;
  onDismiss?: () => void;
  /** "banner" sits under the player after an export; "inline" lives in DETAILS. */
  variant?: "banner" | "inline";
}

/**
 * The share link for a rendered clip, with one-click copy.
 *
 * The token in the URL is the durable artifact, not a signed URL: the
 * /share/<token> page re-signs storage access on every download, so this link
 * keeps working indefinitely while no long-lived signature is ever handed out.
 */
export function ShareBar({ url, downloadCount = 0, onDismiss, variant = "banner" }: Props) {
  // Callers pass key={url}, so a new link remounts this and the "COPIED"
  // confirmation resets on its own — no effect needed to sync it.
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions policy; the input below is
      // selectable, so the link is still obtainable by hand.
    }
  };

  return (
    <div
      className={variant === "banner" ? "panel flex items-center" : "flex flex-col"}
      style={
        variant === "banner"
          ? { gap: 10, padding: "10px 14px", borderLeft: "3px solid var(--acid)" }
          : { gap: 8 }
      }
    >
      <span className="section-label whitespace-nowrap">
        {variant === "banner" ? "CLIP READY" : "SHARE LINK"}
      </span>

      <input
        className="field"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)" }}
      />

      <button type="button" className="btn-export whitespace-nowrap" onClick={() => void copy()}>
        {copied ? "COPIED ✓" : "COPY LINK"}
      </button>

      <a
        className="btn-path whitespace-nowrap"
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{ textDecoration: "none" }}
      >
        OPEN
      </a>

      {downloadCount > 0 && (
        <span className="status-muted whitespace-nowrap">
          {downloadCount} download{downloadCount === 1 ? "" : "s"}
        </span>
      )}

      {onDismiss && (
        <button type="button" className="transport-ghost" onClick={onDismiss} title="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}
