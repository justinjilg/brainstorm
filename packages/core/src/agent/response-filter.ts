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
 * Create a streaming filter that strips filler from the beginning
 * of a text-delta stream.
 *
 * Returns a function that processes each delta. The first few deltas
 * are buffered until we can determine if they match a filler pattern.
 * Once we've passed the buffer threshold, deltas pass through unchanged.
 */
export function createStreamFilter(): (delta: string) => string {
  let buffer = '';
  let flushed = false;
  const BUFFER_THRESHOLD = 80; // chars — enough to detect filler prefixes

  return (delta: string): string => {
    if (flushed) return delta;

    buffer += delta;

    if (buffer.length < BUFFER_THRESHOLD) {
      return ''; // Buffer, don't emit yet
    }

    // We've buffered enough — apply filter and flush
    flushed = true;
    let filtered = buffer;
    for (const pattern of FILLER_PREFIXES) {
      filtered = filtered.replace(pattern, '');
    }
    return filtered;
  };
}

/**
 * Flush any remaining buffered content from a stream filter.
 * Call this when the stream ends.
 */
export function flushStreamFilter(filter: ReturnType<typeof createStreamFilter>): string {
  // Send a large dummy to trigger flush, then extract the buffer
  // This is a no-op if already flushed
  return filter('');
}
