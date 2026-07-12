import { readFileSync } from "node:fs";

/**
 * Channel resolution companion. Maps a channel name to its Discord channel ID
 * using the channels file supplied by the caller. Fails closed: an empty or missing ID resolves to
 * null, never an empty string, so the publish orchestration can refuse to
 * publish to an unconfigured channel.
 *
 * This is intentionally tiny and isolated so the publish orchestration stays
 * pure — orchestration depends only on the `(channelName) => string | null`
 * shape, which this builds.
 */

export class ChannelsError extends Error {
  constructor(message: string) {
    super(`Channels error: ${message}`);
    this.name = "ChannelsError";
  }
}

/** Resolves a channel name to a Discord channel ID, or null when unconfigured. */
export type ChannelResolver = (channelName: string) => string | null;

/**
 * Build a ChannelResolver from an already-parsed channels map. Pure (no I/O) so
 * tests inject their own map. A blank/whitespace ID resolves to null.
 */
export function buildChannelResolver(channels: Record<string, unknown>): ChannelResolver {
  return (channelName: string): string | null => {
    const id = channels[channelName];
    if (typeof id !== "string") return null;
    const trimmed = id.trim();
    return trimmed.length === 0 ? null : trimmed;
  };
}

/**
 * Load + parse the supplied channels file: channel name -> Discord channel ID.
 * Throws ChannelsError on read/parse/shape failure. This module owns channel
 * config as its one external reality; the parsed map serves resolver
 * construction and supplies the channel-NAME universe that definition
 * validation checks assignments against (name membership is definition
 * COHERENCE; whether a name has a provisioned ID is publish's concern).
 */
export function loadChannels(channelsPath: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(channelsPath, "utf8"));
  } catch (e) {
    throw new ChannelsError(`could not read/parse ${channelsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ChannelsError("channels.json must be a JSON object keyed by channel name");
  }
  return raw as Record<string, unknown>;
}

/** Load the supplied channels file and build a resolver from it. Throws on read/parse failure. */
export function loadChannelResolver(channelsPath: string): ChannelResolver {
  return buildChannelResolver(loadChannels(channelsPath));
}