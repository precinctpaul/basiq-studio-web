"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

type Mode = "sql" | "html";

interface SqlResult {
  mode: "sql";
  query: string;
  explanation: string;
  tablesUsed: string[];
  sqlValid: boolean;
  sqlParseError: string;
}

interface HtmlResult {
  mode: "html";
  subject: string;
  htmlBody: string;
}

type Result = SqlResult | HtmlResult;

const PLACEHOLDER: Record<Mode, string> = {
  sql: "e.g. videos with no transcript, grouped by uploader, ordered by size descending",
  html: "e.g. a plain email announcing 3 upcoming committee hearings",
};

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn-path"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        ).finally(() => {
          setTimeout(() => setState("idle"), 1200);
        });
      }}
    >
      {state === "copied" ? "Copied!" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

export default function CodegenPage() {
  const [mode, setMode] = useState<Mode>("sql");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [showRawHtml, setShowRawHtml] = useState(false);

  const generate = () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    fetch("/api/codegen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, prompt: prompt.trim() }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
        }
        setResult(data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  return (
    <div className="flex h-full flex-col">
      <header className="header-bar flex items-center" style={{ padding: "14px 22px", gap: 14 }}>
        <Image
          src="/brand/wordmark.png"
          alt="Majority Democrats"
          height={46}
          width={150}
          priority
          style={{ height: 46, width: "auto" }}
        />
        <span className="section-label whitespace-nowrap">BASIQ STUDIO HUB</span>
        <span style={{ width: 4 }} />
        <span className="section-label whitespace-nowrap" style={{ color: "var(--acid)" }}>
          CODEGEN
        </span>
        <span className="flex-1" />
        <Link href="/" className="btn">
          ← BACK TO STUDIO
        </Link>
      </header>

      <div className="flex items-center gap-2" style={{ padding: "14px 22px" }}>
        <div className="flex gap-1">
          <button
            type="button"
            className="btn-ghost"
            data-checked={mode === "sql" ? "true" : undefined}
            onClick={() => {
              setMode("sql");
              setResult(null);
              setError("");
            }}
          >
            SQL QUERY
          </button>
          <button
            type="button"
            className="btn-ghost"
            data-checked={mode === "html" ? "true" : undefined}
            onClick={() => {
              setMode("html");
              setResult(null);
              setError("");
            }}
          >
            EMAIL HTML
          </button>
        </div>
        <span className="flex-1" />
        <span className="hint">
          {mode === "sql" ? "Generates a read-only query — nothing runs against the database." : "Renders a preview — nothing gets sent."}
        </span>
      </div>

      <div className="flex min-h-0 flex-1" style={{ padding: "0 22px 22px", gap: 16 }}>
        <div className="flex flex-col" style={{ flex: 1, minWidth: 0, gap: 10 }}>
          <span className="section-label">REQUEST</span>
          <textarea
            className="field"
            style={{ flex: 1, resize: "none", minHeight: 160 }}
            placeholder={PLACEHOLDER[mode]}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
            }}
          />
          <button type="button" className="btn-primary" onClick={generate} disabled={loading || !prompt.trim()}>
            {loading ? "GENERATING…" : "GENERATE"}
          </button>
          <span className="hint">Ctrl/Cmd + Enter to generate</span>
        </div>

        <div className="list-surface flex flex-col" style={{ flex: 1, minWidth: 0, padding: 16, gap: 12, overflow: "auto" }}>
          <span className="section-label">RESULT</span>

          {error && (
            <div
              style={{
                padding: "10px 14px",
                background: "rgba(255, 68, 68, 0.1)",
                color: "var(--red)",
                border: "1px solid rgba(255, 68, 68, 0.2)",
              }}
            >
              {error}
            </div>
          )}

          {!error && !result && !loading && <div className="status-muted">Nothing generated yet.</div>}
          {loading && <div className="status-muted">Asking Gemini…</div>}

          {result?.mode === "sql" && (
            <>
              {!result.sqlValid && result.query && (
                <div
                  style={{
                    padding: "8px 12px",
                    background: "rgba(60, 119, 187, 0.12)",
                    color: "var(--blue)",
                    border: "1px solid rgba(60, 119, 187, 0.3)",
                    fontSize: "var(--ts-micro)",
                  }}
                >
                  Couldn&apos;t confirm this parses cleanly as PostgreSQL — review carefully before using it.
                  <div className="status-muted" style={{ marginTop: 4 }}>{result.sqlParseError}</div>
                </div>
              )}
              {result.query ? (
                <>
                  <div className="flex items-start gap-2">
                    <pre
                      className="detail-path"
                      style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontSize: "var(--ts-base)" }}
                    >
                      {result.query}
                    </pre>
                    <CopyButton text={result.query} />
                  </div>
                  <div className="status-muted">{result.explanation}</div>
                  {result.tablesUsed.length > 0 && (
                    <div className="flex gap-1" style={{ flexWrap: "wrap" }}>
                      {result.tablesUsed.map((t) => (
                        <span key={t} className="tag-chip-auto">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="status-muted">{result.explanation || "No query could be generated for that request."}</div>
              )}
            </>
          )}

          {result?.mode === "html" && (
            <>
              <div className="flex items-center gap-2">
                <span style={{ flex: 1 }}>
                  <span className="detail-key">SUBJECT</span>
                  <div className="detail-value">{result.subject}</div>
                </span>
                <button type="button" className="btn-ghost" onClick={() => setShowRawHtml((s) => !s)}>
                  {showRawHtml ? "PREVIEW" : "VIEW CODE"}
                </button>
                <CopyButton text={result.htmlBody} />
              </div>
              {showRawHtml ? (
                <pre
                  className="detail-path"
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, flex: 1, overflow: "auto" }}
                >
                  {result.htmlBody}
                </pre>
              ) : (
                <iframe
                  title="Email preview"
                  srcDoc={result.htmlBody}
                  sandbox=""
                  style={{ flex: 1, width: "100%", background: "#ffffff", border: "1px solid var(--border)" }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
