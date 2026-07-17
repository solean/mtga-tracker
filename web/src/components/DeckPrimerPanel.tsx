import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";

import { api, generateDeckPrimer } from "../lib/api";
import type { DeckPrimer } from "../lib/types";

type GenerationState = "idle" | "generating" | "error";

function formatGeneratedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function DeckPrimerPanel({ deckId }: { deckId: number }) {
  const queryClient = useQueryClient();
  const [generation, setGeneration] = useState<GenerationState>("idle");
  const [streamText, setStreamText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const statusQuery = useQuery({
    queryKey: ["ai-status"],
    queryFn: api.aiStatus,
    staleTime: 1000 * 60 * 10,
  });
  const primerQuery = useQuery({
    queryKey: ["deck-primer", deckId],
    queryFn: () => api.deckPrimer(deckId),
    enabled: Number.isFinite(deckId),
  });

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (generation === "generating") {
      streamEndRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [streamText, generation]);

  const available = statusQuery.data?.available ?? false;
  const primer = primerQuery.data ?? null;

  // Feature stays invisible unless the Claude CLI is installed or a primer
  // was generated in the past — keeps the app fully local by default.
  if (!available && !primer) {
    return null;
  }

  const startGeneration = () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setGeneration("generating");
    setStreamText("");
    setErrorMessage("");

    void generateDeckPrimer(
      deckId,
      {
        onDelta: (text) => setStreamText((current) => current + text),
        onDone: (saved: DeckPrimer) => {
          queryClient.setQueryData(["deck-primer", deckId], saved);
          setGeneration("idle");
          setStreamText("");
        },
        onError: (message) => {
          setErrorMessage(message);
          setGeneration("error");
        },
      },
      controller.signal,
    );
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
    setGeneration("idle");
    setStreamText("");
  };

  const isGenerating = generation === "generating";

  return (
    <section className="panel ai-primer-panel">
      <div className="panel-head">
        <div>
          <h3>AI Primer</h3>
          <p>
            {primer
              ? `Generated ${formatGeneratedAt(primer.createdAt)}${primer.stale ? " • deck has changed since" : ""}`
              : "Strategy guide generated from this deck and your match history"}
          </p>
        </div>
        <div className="ai-primer-actions">
          {primer?.stale && !isGenerating ? <span className="ai-primer-stale-badge">Outdated</span> : null}
          {isGenerating ? (
            <button type="button" className="tab" onClick={cancelGeneration}>
              Cancel
            </button>
          ) : (
            <button type="button" className="tab" onClick={startGeneration} disabled={!available}>
              {primer ? "Regenerate" : "Generate primer"}
            </button>
          )}
        </div>
      </div>

      {generation === "error" ? <div className="ai-primer-error">{errorMessage}</div> : null}

      {isGenerating ? (
        <div className="ai-primer-stream">
          <div className="ai-primer-stream-note">Generating with Claude ({statusQuery.data?.version ?? "CLI"})…</div>
          {streamText ? <pre>{streamText}</pre> : <div className="ai-primer-stream-note">Waiting for first tokens…</div>}
          <div ref={streamEndRef} />
        </div>
      ) : primer ? (
        <div className="ai-primer-content">
          <ReactMarkdown>{primer.content}</ReactMarkdown>
        </div>
      ) : !available ? (
        <div className="ai-primer-stream-note">{statusQuery.data?.detail}</div>
      ) : (
        <div className="ai-primer-stream-note">
          No primer yet. Generation uses your local Claude Code login and usually takes a minute or two.
        </div>
      )}
    </section>
  );
}
