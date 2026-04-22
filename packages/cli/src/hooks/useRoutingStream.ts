/**
 * useRoutingStream — wraps RoutingEventStream consumption for the TUI.
 *
 * Two modes:
 *
 * 1. **External stream (Phase 2 default).** Pass an already-running
 *    `RoutingEventStream` via `externalStream`. The hook subscribes to
 *    its events/state and does NOT own its lifecycle — the caller (the
 *    CLI boot code) controls start/stop so both the dashboard UI and
 *    non-UI consumers (the learned-strategy observer) share one connection.
 *
 * 2. **Self-owned stream (fallback).** If no external stream is provided
 *    but `enabled` + `apiKey` are set, the hook creates and owns its own
 *    stream. Useful for standalone rendering paths; not used in the
 *    normal CLI boot post-Phase-2.
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
  /**
   * Already-running stream owned by someone else (typically the CLI boot
   * code). When provided, the hook subscribes but does NOT start/stop the
   * stream. Takes precedence over `enabled`/`apiKey` self-creation.
   */
  externalStream?: RoutingEventStream;
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
    const external = opts.externalStream;

    // Mode 1: subscribe to caller-owned stream. Don't start/stop it.
    if (external) {
      const unsubEvent = external.onEvent((evt) => {
        setEvents((prev) => {
          const next = [...prev, evt];
          const cap = windowSizeRef.current;
          return next.length > cap ? next.slice(next.length - cap) : next;
        });
        setLastEventId(evt.eventId);
      });
      const unsubGap = external.onGap((gap) => {
        setGapCount((prev) => prev + gap);
      });
      const unsubState = external.onState(setState);
      return () => {
        unsubEvent();
        unsubGap();
        unsubState();
      };
    }

    // Mode 2: self-owned stream (fallback).
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
  }, [opts.enabled, opts.baseUrl, opts.apiKey, opts.externalStream]);

  return { events, state, gapCount, lastEventId };
}
