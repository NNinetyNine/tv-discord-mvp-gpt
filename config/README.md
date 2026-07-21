# VisionX Config — Installation Configuration

This directory holds installation configuration: environment-owned plumbing
(Constitution §2.2.4). It is data only.

The domain-definition files (`registry.json`, `packs.json`) live in
`definitions/` — their permanent home per the §8.8 ruling. See
`definitions/README.md`.

## channels.json

Maps each channel name to its Discord channel ID. IDs are intentionally left
empty (`""`) until provisioned. Channel *names* are the universe that pack
channel assignments are validated against; the *IDs* are environment
provisioning, filled in as channels are wired.

## tickers.json

Legacy-runtime data (`npm run start`); retires with the legacy runtime at the
runtime flip.

## asset-threads.json

Maps each Pack/Asset pair to the persistent Discord forum thread that owns that
Asset's chronological chart history. The file is versioned installation
configuration. Missing bindings make publication fail closed before Discord is
contacted or a Release is created.

The initial empty map is intentional. Existing Discord forum posts must be
explicitly adopted or newly provisioned before publication is enabled.
