import { describe, it, expect } from "vitest";
import { resolve as resolvePath } from "node:path";

import { buildChannelResolver, loadChannelResolver, ChannelsError } from "./channels.ts";

describe("buildChannelResolver — pure resolution", () => {
  it("resolves a configured channel name to its id", () => {
    const resolve = buildChannelResolver({ crypto: "123456", stocks: "789" });
    expect(resolve("crypto")).toBe("123456");
    expect(resolve("stocks")).toBe("789");
  });

  it("returns null for an unknown channel name", () => {
    const resolve = buildChannelResolver({ crypto: "123" });
    expect(resolve("nope")).toBeNull();
  });

  it("fails closed: an empty id resolves to null (not '')", () => {
    const resolve = buildChannelResolver({ crypto: "" });
    expect(resolve("crypto")).toBeNull();
  });

  it("fails closed: a whitespace-only id resolves to null", () => {
    const resolve = buildChannelResolver({ crypto: "   " });
    expect(resolve("crypto")).toBeNull();
  });

  it("trims surrounding whitespace from a real id", () => {
    const resolve = buildChannelResolver({ crypto: "  123456  " });
    expect(resolve("crypto")).toBe("123456");
  });

  it("returns null for a non-string id value", () => {
    const resolve = buildChannelResolver({ crypto: 123 as unknown as string });
    expect(resolve("crypto")).toBeNull();
  });
});

describe("loadChannelResolver — real config", () => {
  it("loads config/channels.json and builds a working resolver", () => {
    const resolve = loadChannelResolver(resolvePath(process.cwd(), "config", "channels.json"));
    expect(typeof resolve).toBe("function");
    expect(resolve("crypto")).toBe("1519158079302664302");
  });
});

describe("ChannelsError", () => {
  it("is the exported error type", () => {
    expect(new ChannelsError("x")).toBeInstanceOf(Error);
  });
});