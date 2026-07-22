# Discord thread routing administration

The local administration UI includes a **Threads** room for inspecting routing
coverage, adopting existing Discord forum posts, and explicitly provisioning
new posts as persistent Pack/Asset destinations.

Chart publication remains unavailable in this room. Adoption is read-only on
Discord. Provisioning is a separate confirmed action with governed starter-logo
custody, live forum-tag inspection, durable binding, and compensation.

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

## Pack routing readiness

Coverage is necessary but is not proof that a destination still works. Once a
Pack has a configured forum and one persistent binding for every member, the UI
enables **Verify Pack Routing**. This is a separately confirmed, read-only gate.

The verifier:

1. snapshots the governed binding file;
2. fails before Discord contact if any Pack binding is missing, malformed, or
   duplicated;
3. opens one short-lived Discord session;
4. inspects every bound destination sequentially in canonical Pack order;
5. requires each thread to exist, report the expected identity, remain in the
   Pack's configured forum, and be active and unlocked;
6. closes the session and rereads the binding file;
7. discards the result if binding custody changed during inspection.

Missing or inaccessible threads, wrong-parent threads, archived threads,
locked threads, and unknown archive or lock state are visible per-Asset
blockers. A session-close failure also withholds readiness. Verification does
not edit Discord content or bindings and does not stage or publish a chart or
create a Release. Its result is intentionally transient and is invalidated
when the binding source changes.

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

## New-post provisioning

Provisioning is enabled only when the administration process starts with an
explicit `DISCORD_BOT_TOKEN`. Merely starting the server, viewing coverage, or
uploading a logo does not open a Discord session.

The operator workflow is:

1. select an unbound Pack Asset;
2. explicitly inspect the Pack's current forum name and available tags;
3. enter the exact post title and select at most five inspected tags;
4. upload a square, single-frame PNG starter logo;
5. review the logo SHA-256 and confirm the complete request;
6. create one forum post and atomically write its persistent binding;
7. close the short-lived Discord session.

The logo is stored only in the administration workspace, not canonical
repository custody. The confirmed request repeats its SHA-256, so replacement
between review and execution fails before Discord contact.

All Registry, Pack, channel, and binding checks run again under the thread
mutation lock. If Discord creates the post but durable binding fails, VisionX
uses the same provisioning session to delete only that provisional post. If
deletion fails, the API reports the retained thread ID and blocks silent retry.

## Deliberate exclusions

The Threads room has no controls or API route for:

- deleting an existing or previously bound Discord post;
- editing an existing post's title, tags, messages, archive state, or lock state;
- changing or removing an existing binding;
- staging or publishing charts;
- creating or changing Releases.

Those capabilities require separate governed milestones.
