/**
 * useRoutingStream — wraps RoutingEventStream lifecycle for the TUI.
 *
 * Opens the SSE subscriber on mount (when enabled + credentials present),
 * captures the last N events into a rolling window, exposes the current
 * connection state, and tears down cleanly on unmount.
 *
 * Phase 1 scope: owned at the component that displays the Live Routing
 * panel (DashboardMode). Phase 2 moves this up to the App root so that
 * local routing strategies (learned/Thompson, capability/Wilson) can also
 * subscribe without re-opening the connection.
 */

import { useEffect, useRef, useState } from "react";
import {
  RoutingEventStream,
  type ConnectionState,
  type RoutingStreamEvent,
} from "@brainst0rm/gateway";

export interface UseRoutingStreamOptions {
  /** Enables the stream. Typically wired to `config.routing.routingStream`. */
  enabled: boolean;
  /** BR base URL. Falls back to the default production URL if unset. */
  baseUrl?: string;
  /** API key. If absent, the hook stays idle even when `enabled` is true. */
  apiKey?: string;
  /** Max events to retain in the rolling window. Default 50. */
  windowSize?: number;
}

export interface UseRoutingStreamResult {
  events: RoutingStreamEvent[];
  state: ConnectionState;
  gapCount: number;
  lastEventId: number;
}

const DEFAULT_BR_URL = "https://api.brainstormrouter.com";

export function useRoutingStream(
  opts: UseRoutingStreamOptions,
): UseRoutingStreamResult {
  const [events, setEvents] = useState<RoutingStreamEvent[]>([]);
  const [state, setState] = useState<ConnectionState>({ phase: "idle" });
  const [gapCount, setGapCount] = useState(0);
  const [lastEventId, setLastEventId] = useState(0);
  const windowSize = opts.windowSize ?? 50;
  const windowSizeRef = useRef(windowSize);
  windowSizeRef.current = windowSize;

  useEffect(() => {
    if (!opts.enabled || !opts.apiKey) {
      setState({ phase: "idle" });
      return;
    }

    const stream = new RoutingEventStream({
      baseUrl: opts.baseUrl ?? DEFAULT_BR_URL,
      apiKey: opts.apiKey,
    });

    const unsubEvent = stream.onEvent((evt) => {
      setEvents((prev) => {
        const next = [...prev, evt];
        const cap = windowSizeRef.current;
        return next.length > cap ? next.slice(next.length - cap) : next;
      });
      setLastEventId(evt.eventId);
    });
    const unsubGap = stream.onGap((gap) => {
      setGapCount((prev) => prev + gap);
    });
    const unsubState = stream.onState(setState);

    stream.start();

    return () => {
      unsubEvent();
      unsubGap();
      unsubState();
      stream.stop("component unmount");
    };
  }, [opts.enabled, opts.baseUrl, opts.apiKey]);

  return { events, state, gapCount, lastEventId };
}
