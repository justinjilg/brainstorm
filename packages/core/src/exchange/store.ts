/**
 * A small in-process registry of recent exchanges so the UI can list/get them
 * without a full DB round-trip. The live events already ride the organism bus
 * and its ring buffer; this holds just the durable summary per exchange.
 */
export interface ExchangeRecord {
  exchangeId: string;
  prompt: string;
  participants: string[];
  status: "running" | "reconciled" | "aborted";
  resolution?: string;
  method?: string;
  startedAt: number;
  endedAt?: number;
  totalCost?: number;
}

const records = new Map<string, ExchangeRecord>();
const MAX = 100;

export function recordExchangeStart(
  rec: Omit<ExchangeRecord, "status" | "startedAt">,
): void {
  records.set(rec.exchangeId, {
    ...rec,
    status: "running",
    startedAt: Date.now(),
  });
  // Bound the map — evict the oldest by insertion order.
  if (records.size > MAX) {
    const oldest = records.keys().next().value;
    if (oldest) records.delete(oldest);
  }
}

export function recordExchangeEnd(
  exchangeId: string,
  patch: Partial<
    Pick<ExchangeRecord, "status" | "resolution" | "method" | "totalCost">
  >,
): void {
  const rec = records.get(exchangeId);
  if (!rec) return;
  Object.assign(rec, patch, { endedAt: Date.now() });
}

/** Most-recent-first list of exchange summaries. */
export function listExchanges(limit = 25): ExchangeRecord[] {
  return [...records.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export function getExchange(exchangeId: string): ExchangeRecord | undefined {
  return records.get(exchangeId);
}

/** Test seam. */
export function resetExchangeStore(): void {
  records.clear();
}
