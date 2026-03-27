/**
 * Hook to lazily fetch BrainstormRouter dashboard data.
 * Caches results and refreshes on demand.
 */

import { useState, useCallback } from "react";

export interface BRDashboardData {
  leaderboard: Array<{
    model: string;
    provider: string;
    quality_rank: number;
    speed_rank: number;
    value_rank: number;
    request_count: number;
    avg_latency_ms: number;
  }>;
  waste: {
    total_waste_usd: number;
    suggestions: Array<{
      description: string;
      savings_usd: number;
      action: string;
    }>;
  } | null;
  forecast: {
    current_spend: number;
    budget_limit: number;
    projected_spend: number;
    will_exceed: boolean;
    days_remaining: number;
  } | null;
  audit: Array<{
    request_id: string;
    timestamp: string;
    model: string;
    cost_usd: number;
    latency_ms: number;
    guardian_status: string;
  }>;
  dailyTrend: Array<{
    date: string;
    cost_usd: number;
    request_count: number;
  }>;
  lastFetched: number;
  loading: boolean;
  error: string | null;
}

const EMPTY_DATA: BRDashboardData = {
  leaderboard: [],
  waste: null,
  forecast: null,
  audit: [],
  dailyTrend: [],
  lastFetched: 0,
  loading: false,
  error: null,
};

/**
 * Fetch BR dashboard data using the gateway client.
 * Pass null if no gateway is available (no BR key).
 */
export function useBRData(gateway: any | null) {
  const [data, setData] = useState<BRDashboardData>(EMPTY_DATA);

  const refresh = useCallback(async () => {
    if (!gateway) {
      setData((prev) => ({
        ...prev,
        error: "No BrainstormRouter API key configured",
      }));
      return;
    }

    setData((prev) => ({ ...prev, loading: true, error: null }));

    try {
      // Fetch all endpoints in parallel (best-effort for each)
      const [leaderboard, waste, forecast, audit, daily] =
        await Promise.allSettled([
          gateway.getLeaderboard(),
          gateway.getWasteInsights(),
          gateway.getForecast(),
          gateway.getCompletionAudit("24h"),
          gateway.getDailyInsights(),
        ]);

      setData({
        leaderboard:
          leaderboard.status === "fulfilled" ? leaderboard.value : [],
        waste: waste.status === "fulfilled" ? waste.value : null,
        forecast: forecast.status === "fulfilled" ? forecast.value : null,
        audit: audit.status === "fulfilled" ? audit.value.slice(0, 10) : [],
        dailyTrend: daily.status === "fulfilled" ? daily.value.slice(0, 7) : [],
        lastFetched: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err: any) {
      setData((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, [gateway]);

  return { data, refresh };
}
