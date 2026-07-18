import { buildChannelResolver } from "../wiring/channels.ts";
import type { ProposedAssetMarketIdentity } from "./asset-market-identity.ts";

export const ASSET_REGISTRATION_CHANNEL_MAX_LENGTH = 32 as const;

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const DISCORD_SNOWFLAKE = /^[0-9]{17,20}$/u;

export interface ChannelAwareProposedAssetMarketIdentity extends ProposedAssetMarketIdentity {
  readonly channel: string;
}

export type AssetRegistrationChannelFailureReason =
  | "proposal_channel_required"
  | "invalid_channel"
  | "unknown_channel"
  | "unresolved_channel";

export interface AssetRegistrationChannelFailure {
  readonly ok: false;
  readonly reason: AssetRegistrationChannelFailureReason;
  readonly detail: string;
}

export interface AssetRegistrationChannelSuccess {
  readonly ok: true;
  readonly channel: string;
}

export type AssetRegistrationChannelResult =
  | AssetRegistrationChannelSuccess
  | AssetRegistrationChannelFailure;

function failure(
  reason: AssetRegistrationChannelFailureReason,
  detail: string,
): AssetRegistrationChannelFailure {
  return Object.freeze({ ok: false, reason, detail });
}

export function validateAssetRegistrationChannel(
  value: unknown,
  channels: Readonly<Record<string, unknown>>,
): AssetRegistrationChannelResult {
  if (value === undefined) {
    return failure("proposal_channel_required", "asset.channel is required for schemaVersion 2");
  }
  if (typeof value !== "string") {
    return failure("invalid_channel", "asset.channel must be a logical channel key string");
  }
  if (value.length === 0 || value.trim().length === 0) {
    return failure("invalid_channel", "asset.channel must not be empty or whitespace-only");
  }
  if (value.trim() !== value) {
    return failure("invalid_channel", "asset.channel must not contain outer whitespace");
  }
  if (CONTROL_CHARACTER.test(value)) {
    return failure("invalid_channel", "asset.channel must not contain control characters or newlines");
  }
  if (value.length > ASSET_REGISTRATION_CHANNEL_MAX_LENGTH) {
    return failure(
      "invalid_channel",
      `asset.channel exceeds maximum length ${ASSET_REGISTRATION_CHANNEL_MAX_LENGTH}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(channels, value)) {
    return failure("unknown_channel", `asset.channel ${value} is not a configured logical channel key`);
  }
  const resolved = buildChannelResolver(channels)(value);
  if (resolved === null || !DISCORD_SNOWFLAKE.test(resolved)) {
    return failure(
      "unresolved_channel",
      `asset.channel ${value} does not resolve to a usable Discord snowflake`,
    );
  }
  return Object.freeze({ ok: true, channel: value });
}

export function validateChannelAwareProposedAsset(
  asset: ProposedAssetMarketIdentity,
  channelValue: unknown,
  channels: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly asset: ChannelAwareProposedAssetMarketIdentity }
  | AssetRegistrationChannelFailure {
  const channel = validateAssetRegistrationChannel(channelValue, channels);
  if (!channel.ok) return channel;
  return Object.freeze({
    ok: true,
    asset: Object.freeze({ ...asset, channel: channel.channel }),
  });
}
