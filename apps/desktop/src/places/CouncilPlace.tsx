/**
 * Council — models talking to models (the north star).
 *
 * Phase 2 ships this as a legible placeholder that already reads live exchange
 * activity off the organism bus, so the moment Phase 3 wires the Exchange
 * primitive (packages/core/src/exchange), deliberations stream in here with no
 * further shell work. Until then it shows any exchange.* events the bus carries
 * and an honest "not yet convened" state — never a fake demo.
 */
import { useMemo, useState } from "react";
import { useOrganism } from "../hooks/useOrganism";
import { organismEventLabel } from "../lib/organism";
import { request } from "../lib/ipc-client";

export function CouncilPlace() {
  const { feed, state, connected } = useOrganism();
  const [question, setQuestion] = useState("");
  const [convening, setConvening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchangeEvents = useMemo(
    () => feed.filter((e) => e.type.startsWith("exchange")),
    [feed],
  );

  const convene = async () => {
    const prompt = question.trim();
    if (!prompt || convening) return;
    setConvening(true);
    setError(null);
    try {
      // Fire-and-watch: the exchange streams its events onto the organism bus,
      // so they appear below live via useOrganism — no need to hold the stream.
      await request("exchange.start", { prompt });
      setQuestion("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to convene the council",
      );
    } finally {
      setConvening(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1
            style={{
              fontFamily: "var(--font-display, serif)",
              fontSize: "var(--text-2xl)",
              color: "var(--ctp-text)",
            }}
          >
            Council
          </h1>
          <p
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-subtext0)" }}
            className="mt-1"
          >
            Models deliberating — proposing, challenging, voting — through
            BrainstormRouter. Watchable and replayable.
          </p>
        </header>

        {/* Convene a council — the north star, one question away. */}
        <div className="mb-6 flex items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") convene();
            }}
            placeholder="Ask the council a question…"
            disabled={convening}
            className="flex-1 px-3 py-2 rounded outline-none"
            style={{
              background: "var(--ctp-base)",
              border: "1px solid var(--border-subtle)",
              fontSize: "var(--text-sm)",
              color: "var(--ctp-text)",
            }}
          />
          <button
            onClick={convene}
            disabled={convening || !question.trim()}
            data-testid="convene-council"
            className="px-3 py-2 rounded hover:brightness-125 disabled:opacity-50"
            style={{
              fontSize: "var(--text-sm)",
              background: "var(--ctp-surface0)",
              border: "1px solid var(--paint-lavender)",
              color: "var(--paint-lavender)",
            }}
          >
            {convening ? "Convening…" : "Convene"}
          </button>
        </div>
        {error && (
          <div
            className="mb-4"
            style={{ fontSize: "var(--text-xs)", color: "var(--ctp-red)" }}
          >
            {error}
          </div>
        )}

        {exchangeEvents.length === 0 ? (
          <div
            className="rounded px-5 py-8 text-center"
            style={{
              background: "var(--ctp-base)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <div
              className="mx-auto mb-3"
              style={{
                width: 14,
                height: 14,
                borderRadius: "9999px",
                border: "1px solid var(--paint-lavender)",
                opacity: 0.7,
              }}
            />
            <div
              style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
            >
              No council in session
            </div>
            <div
              className="mt-1"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay1)",
              }}
            >
              {connected
                ? "Escalate a question from Talk, or KAIROS will convene one before a high-stakes self-heal. (Live in Phase 3.)"
                : "Connecting to the organism…"}
            </div>
            {state.exchanges.active > 0 && (
              <div
                className="mt-2"
                style={{ fontSize: "var(--text-xs)", color: "var(--organism)" }}
              >
                {state.exchanges.active} active exchange(s)…
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {exchangeEvents.map((e) => (
              <div
                key={e.seq}
                className="animate-fade-in rounded px-3 py-2"
                style={{
                  background: "var(--ctp-base)",
                  border: "1px solid var(--border-subtle)",
                  fontSize: "var(--text-sm)",
                }}
              >
                <span style={{ color: "var(--ctp-text)" }}>
                  {organismEventLabel(e)}
                </span>
                <span
                  className="ml-2 font-mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ctp-overlay0)",
                  }}
                >
                  {e.actor}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
