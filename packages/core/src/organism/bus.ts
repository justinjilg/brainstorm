/**
 * The organism bus — the single live spine every Brainstorm surface subscribes
 * to instead of re-querying state over a poll.
 *
 * It is a typed emitter + a monotonic-seq ring buffer + a materialized
 * {@link OrganismState} snapshot. A producer publishes a bare
 * {@link OrganismEventInput}; the bus stamps `seq`/`ts`/`actor`, folds the event
 * into the snapshot, buffers it for gapless resume, and fans it out to every
 * subscriber. Surfaces become projections of this one stream: the desktop's
 * `useOrganism()` hook, `serve`'s `/organism/events` SSE, and the TUI status
 * strip all read from here rather than each re-implementing a dashboard.
 *
 * This generalizes the fold pattern already proven in the desktop's
 * `useKairosActivity` hook — made the ONLY pattern, on the producer side.
 */
import { EventEmitter } from "node:events";
import {
  foldOrganismState,
  initialOrganismState,
  type OrganismEvent,
  type OrganismEventInput,
  type OrganismState,
} from "@brainst0rm/shared";

export interface OrganismBusOptions {
  /**
   * Ring-buffer capacity retained for replay / gapless resume (`since`).
   * Older events are evicted; a resumer whose `sinceSeq` predates the buffer
   * simply re-syncs from the snapshot. Default 500.
   */
  bufferSize?: number;
}

export class OrganismBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: OrganismEvent[] = [];
  private readonly bufferSize: number;
  private seq = 0;
  private state: OrganismState = initialOrganismState();

  constructor(opts: OrganismBusOptions = {}) {
    this.bufferSize = opts.bufferSize ?? 500;
    // Every surface + internal consumer attaches a listener; no artificial cap.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Publish an event. Stamps the envelope (`seq`/`ts`/`actor`), folds it into
   * the snapshot, buffers it, and emits to subscribers. Returns the stamped
   * event so a caller can read the assigned `seq`.
   */
  publish(input: OrganismEventInput): OrganismEvent {
    const event = {
      ...input,
      seq: ++this.seq,
      ts: Date.now(),
      actor: input.actor ?? "system",
    } as OrganismEvent;
    foldOrganismState(this.state, event);
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.emitter.emit("event", event);
    return event;
  }

  /** Subscribe to every FUTURE event. Returns an unsubscribe function. */
  subscribe(listener: (ev: OrganismEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  /** The current materialized snapshot (a defensive copy). */
  snapshot(): OrganismState {
    return structuredClone(this.state);
  }

  /**
   * Buffered events with `seq` strictly greater than `sinceSeq` — the gapless
   * tail a resuming subscriber replays after taking the snapshot. Empty when
   * `sinceSeq` is current; may be partial if the resumer fell behind the
   * buffer (the caller detects that via the snapshot's implied seq and re-syncs).
   */
  since(sinceSeq: number): OrganismEvent[] {
    return this.buffer.filter((e) => e.seq > sinceSeq);
  }

  /** The highest `seq` emitted so far (0 before the first publish). */
  currentSeq(): number {
    return this.seq;
  }
}

let singleton: OrganismBus | null = null;

/**
 * The process-wide organism bus. Producers across core (daemon, router bridge,
 * exchange) publish here without threading an instance; the IPC/SSE layer
 * subscribes here. Mirrors the singleton accessors elsewhere in the codebase
 * (e.g. `getToolHealthTracker`).
 */
export function getOrganismBus(): OrganismBus {
  if (!singleton) singleton = new OrganismBus();
  return singleton;
}

/** Replace the process-wide bus (tests, or a host that owns the lifecycle). */
export function setOrganismBus(bus: OrganismBus): void {
  singleton = bus;
}

/** Drop the process-wide bus (test seam). */
export function resetOrganismBus(): void {
  singleton = null;
}
