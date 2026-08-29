/**
 * useOrganism — the desktop's single projection of the organism bus.
 *
 * One subscription (`organism.subscribe`) replaces the app's polling paths: the
 * port-3100 health poll (`useServerHealth`), `useKairos` status polling, and the
 * raw daemon-frame fold in `useKairosActivity`. The renderer takes the server's
 * snapshot, then folds every streamed event to keep vitals live — no interval,
 * no re-fetch. This is the ONLY live-state pattern the flagship uses.
 *
 * The subscription is a MODULE-LEVEL, ref-counted shared store: the IPC handler
 * keeps a single subscription slot per connection, so every consumer must share
 * one subscribe/unsubscribe pair. N hooks → one subscription, torn down only
 * when the last consumer unmounts.
 */

import { useRef, useSyncExternalStore } from "react";
import { request } from "../lib/ipc-client";
import {
  cloneState,
  foldOrganism,
  initialOrganismState,
  type OrganismEvent,
  type OrganismState,
} from "../lib/organism";

/** Bounded activity feed — the seed of the Pulse ledger ("Changelog of Self"). */
const MAX_FEED = 60;

export interface UseOrganismResult {
  state: OrganismState;
  feed: OrganismEvent[];
  /** True once the initial snapshot has arrived. */
  connected: boolean;
}

// ── Module-level shared store ────────────────────────────────────────────────
let store: UseOrganismResult = {
  state: initialOrganismState(),
  feed: [],
  connected: false,
};
// Highest seq seen — sent as `sinceSeq` on (re)subscribe for gapless resume.
let lastSeq = 0;
let refCount = 0;
let unlisten: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function handleFrame(raw: unknown): void {
  const frame = raw as { event?: string; data?: unknown };
  if (frame.event === "organism-snapshot") {
    const payload = frame.data as { state?: OrganismState; seq?: number };
    store = {
      state: payload?.state ?? store.state,
      feed: store.feed,
      connected: true,
    };
    if (typeof payload?.seq === "number") lastSeq = payload.seq;
    notify();
  } else if (frame.event === "organism") {
    const event = frame.data as OrganismEvent | undefined;
    if (!event || typeof event.seq !== "number") return;
    lastSeq = Math.max(lastSeq, event.seq);
    const nextState = cloneState(store.state);
    foldOrganism(nextState, event);
    store = {
      state: nextState,
      feed: [event, ...store.feed].slice(0, MAX_FEED),
      connected: true,
    };
    notify();
  }
}

let subscribed = false; // true only AFTER organism.subscribe resolves ok
let subscribeInFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Ensure the backend is actually streaming to us. Decoupled from listener
 * registration so a FAILED initial subscribe (backend not ready) doesn't leave
 * us half-subscribed forever: it retries with backoff while consumers remain.
 */
function ensureSubscribed(): void {
  if (refCount <= 0 || subscribed || subscribeInFlight) return;
  if (!("brainstorm" in window) || !window.brainstorm) return;
  subscribeInFlight = true;
  void request("organism.subscribe", { sinceSeq: lastSeq })
    .then(() => {
      subscribed = true;
      subscribeInFlight = false;
    })
    .catch(() => {
      subscribeInFlight = false;
      // Backend not ready yet — retry while at least one consumer is mounted.
      if (refCount > 0 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          ensureSubscribed();
        }, 1500);
      }
    });
}

function acquire(): void {
  refCount += 1;
  if (!("brainstorm" in window) || !window.brainstorm) return;
  // Register the frame listener exactly once; (re)subscribe independently so a
  // dropped/failed subscribe can recover without re-registering the listener.
  if (!unlisten) unlisten = window.brainstorm.onChatEvent(handleFrame);
  ensureSubscribed();
}

function release(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return; // other consumers still mounted
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  subscribed = false;
  subscribeInFlight = false;
  void request("organism.unsubscribe").catch(() => {});
}

/**
 * `useSyncExternalStore` subscription: register the listener, ref-count the
 * shared IPC subscription in, and tear down on the last unmount. This is the
 * sanctioned way to bind an external mutable store to React — it is tearing-safe
 * under concurrent rendering and behaves correctly under Fast Refresh / test
 * isolation, which a bespoke useState+useEffect bridge over module state is not.
 */
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  acquire();
  return () => {
    listeners.delete(onChange);
    release();
  };
}

/** getSnapshot — `store` is replaced (new identity) on every change, so
 * useSyncExternalStore's Object.is check re-renders exactly when it should. */
function getSnapshot(): UseOrganismResult {
  return store;
}

export function useOrganism(): UseOrganismResult {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to a SLICE of the organism, re-rendering only when that slice
 * changes (by `isEqual`, default Object.is). This is the selector escape hatch
 * for consumers that care about one vital (e.g. just KAIROS status) and must not
 * re-render on every high-frequency `route.*`/`exchange.turn-*` burst. Caches the
 * selected value per component so an unchanged selection keeps a stable identity.
 */
export function useOrganismSelector<T>(
  selector: (o: UseOrganismResult) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const last = useRef<{ value: T } | null>(null);
  const getSelection = (): T => {
    const next = selector(store);
    if (last.current && isEqual(last.current.value, next))
      return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}
