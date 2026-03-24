/**
 * Lightweight response filter that strips common LLM filler patterns.
 *
 * Applied to the beginning of streamed text output. Not aggressive —
 * only strips patterns that are clearly filler, not meaningful content.
 * The system prompt does the heavy lifting; this catches what leaks through.
 */

const FILLER_PREFIXES = [
  /^(Sure!|Of course!|Absolutely!|Great question!|Great!|Certainly!)\s*/i,
  /^(I'd be happy to help[.!]?\s*)/i,
  /^(I'd be glad to[.!]?\s*)/i,
  /^(Let me help you with that[.!]?\s*)/i,
  /^(That's a great question[.!]?\s*)/i,
  /^(No problem[.!]?\s*)/i,
  /^(Alright[,!]?\s*)/i,
];

const TRAILING_SUMMARIES = [
  /\n\n(In summary,|To summarize,|To recap,|In conclusion,|Overall,)[\s\S]{0,500}$/i,
];

/**
 * Filter a complete response text, stripping filler patterns.
 * Used for non-streaming contexts (e.g., subagent results).
 */
export function filterResponse(text: string): string {
  let result = text;

  // Strip leading filler
  for (const pattern of FILLER_PREFIXES) {
    result = result.replace(pattern, '');
  }

  // Strip trailing summaries
  for (const pattern of TRAILING_SUMMARIES) {
    result = result.replace(pattern, '');
  }

  return result;
}

/**
 * Streaming filter that strips filler from the beginning of a text-delta stream.
 *
 * Buffers the first few deltas to detect filler prefixes.
 * Call `filter(delta)` for each text-delta, then `flush()` when the stream ends.
 */
export interface StreamFilter {
  /** Process a text delta. Returns filtered text to emit (may be empty while buffering). */
  filter(delta: string): string;
  /** Flush remaining buffered content. Call when the stream ends. */
  flush(): string;
}

const BUFFER_THRESHOLD = 80; // chars — enough to detect filler prefixes

export function createStreamFilter(): StreamFilter {
  let buffer = '';
  let flushed = false;

  function applyFilters(text: string): string {
    let filtered = text;
    for (const pattern of FILLER_PREFIXES) {
      filtered = filtered.replace(pattern, '');
    }
    return filtered;
  }

  return {
    filter(delta: string): string {
      if (flushed) return delta;

      buffer += delta;

      if (buffer.length < BUFFER_THRESHOLD) {
        return ''; // Buffer, don't emit yet
      }

      // We've buffered enough — apply filter and flush
      flushed = true;
      return applyFilters(buffer);
    },

    flush(): string {
      if (flushed) return '';
      flushed = true;
      return applyFilters(buffer);
    },
  };
}
