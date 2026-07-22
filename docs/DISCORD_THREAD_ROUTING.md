# Discord thread routing administration

The local administration UI includes a **Threads** room for inspecting routing
coverage and adopting existing Discord forum posts as persistent Pack/Asset
destinations.

This room is deliberately adoption-only. It does not create forum posts,
change Discord content, publish a chart, or create a Release. New-thread
provisioning remains unavailable until governed per-Asset logo custody and
forum-tag selection are part of the operator workflow.

## Coverage dashboard

`GET /api/v1/thread-management` reads `config/asset-threads.json` as an
installation-owned source and reports:

- total, bound, and missing Asset destinations;
- per-Pack coverage in canonical Pack order;
- every Pack member in canonical member order;
- the current persistent thread ID, when bound;
- whether the Pack forum is configured;
- whether Discord inspection is available to the running administration
  process.

The source fails closed if it is not a regular non-symlink file, does not match
the supported schema, references an unknown Pack or non-member Asset, or maps
one Discord thread to more than one Pack Asset.

## Existing-post adoption

The administration process enables adoption only when `DISCORD_BOT_TOKEN` is
present at startup. No Discord connection is opened merely by starting the
server or viewing the dashboard.

An explicit **Inspect & Adopt** action performs this sequence:

1. require a current confirmation from the UI;
2. refresh canonical Registry, Pack, and channel state;
3. reject a conflicting existing binding before Discord contact;
4. open one short-lived Discord session;
5. inspect the supplied thread without editing it;
6. verify that the thread belongs to the selected Pack's configured forum;
7. atomically add the Pack/Asset binding;
8. close the Discord session.

The existing post's title, tags, starter message, history, archive state, and
lock state are preserved. An exact repeated binding is idempotent. A different
thread cannot silently replace an existing binding.

## Deliberate exclusions

The Threads room has no controls or API route for:

- creating or deleting Discord posts;
- editing titles, tags, messages, archive state, or lock state;
- changing or removing an existing binding;
- staging or publishing charts;
- creating or changing Releases.

Those capabilities require separate governed milestones.
