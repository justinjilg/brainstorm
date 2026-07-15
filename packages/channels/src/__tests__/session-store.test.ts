import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { ChannelSessionStore } from "../session-store.js";

function makeStore(): ChannelSessionStore {
  const db = new Database(":memory:");
  return new ChannelSessionStore(db);
}

describe("ChannelSessionStore", () => {
  it("resolve returns null for an unknown key", () => {
    const store = makeStore();
    expect(
      store.resolve({
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "1.1",
      }),
    ).toBeNull();
  });

  it("bind then resolve round-trips", () => {
    const store = makeStore();
    const key = {
      channelType: "slack",
      teamId: "T1",
      channelId: "C1",
      threadKey: "1.1",
    };
    store.bind(key, "conv-abc");
    expect(store.resolve(key)).toBe("conv-abc");
  });

  it("distinct threadKeys are isolated", () => {
    const store = makeStore();
    const base = { channelType: "slack", teamId: "T1", channelId: "C1" };
    store.bind({ ...base, threadKey: "1.1" }, "conv-a");
    store.bind({ ...base, threadKey: "2.2" }, "conv-b");
    expect(store.resolve({ ...base, threadKey: "1.1" })).toBe("conv-a");
    expect(store.resolve({ ...base, threadKey: "2.2" })).toBe("conv-b");
  });

  it("teamId undefined vs 'T1' are isolated", () => {
    const store = makeStore();
    const base = { channelType: "slack", channelId: "C1", threadKey: "1.1" };
    store.bind({ ...base, teamId: undefined }, "conv-no-team");
    store.bind({ ...base, teamId: "T1" }, "conv-team-1");
    expect(store.resolve({ ...base, teamId: undefined })).toBe("conv-no-team");
    expect(store.resolve({ ...base, teamId: "T1" })).toBe("conv-team-1");
  });

  it("rebind overwrites the existing conversation id", () => {
    const store = makeStore();
    const key = {
      channelType: "slack",
      teamId: "T1",
      channelId: "C1",
      threadKey: "1.1",
    };
    store.bind(key, "conv-first");
    store.bind(key, "conv-second");
    expect(store.resolve(key)).toBe("conv-second");
  });
});
