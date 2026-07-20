import { describe, expect, it } from "vitest";

import { validateAssetRegistrationChannel } from "./asset-registration-channel.ts";

const CHANNELS = Object.freeze({
  crypto: "1527846955668078663",
  stocks: "1527846988270534827",
  indices: "1527847099394162688",
  commodities: "1527847314889244893",
  etfs: "1527847370807705852",
  forex: "1528609079822516305",
});

describe("Asset registration logical channel", () => {
  it.each(["stocks", "forex"])("accepts explicit configured logical key %s", (channel) => {
    expect(validateAssetRegistrationChannel(channel, CHANNELS)).toEqual({
      ok: true,
      channel,
    });
  });

  it.each([
    [undefined, "proposal_channel_required"],
    [null, "invalid_channel"],
    [[], "invalid_channel"],
    [{}, "invalid_channel"],
    ["", "invalid_channel"],
    ["   ", "invalid_channel"],
    [" stocks", "invalid_channel"],
    ["stocks ", "invalid_channel"],
    ["Stocks", "unknown_channel"],
    ["1527846988270534827", "unknown_channel"],
    ["missing", "unknown_channel"],
  ])("rejects invalid explicit value %j", (value, reason) => {
    expect(validateAssetRegistrationChannel(value, CHANNELS)).toMatchObject({ ok: false, reason });
  });

  it.each([
    [""],
    ["   "],
    ["not-a-snowflake"],
    ["1234"],
  ])("rejects configured keys with unusable id %j", (id) => {
    expect(validateAssetRegistrationChannel("stocks", { ...CHANNELS, stocks: id })).toMatchObject({
      ok: false,
      reason: "unresolved_channel",
    });
  });
});
