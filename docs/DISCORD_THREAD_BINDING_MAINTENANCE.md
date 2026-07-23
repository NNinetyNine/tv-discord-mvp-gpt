# Discord thread binding maintenance

The Threads room exposes the persistent route for every Pack Asset, including
already-bound Assets such as BTC. A row-level **Manage** action selects the
Asset and opens its current Thread ID in **Binding Management**.

## Verify Current Binding

This control exists to distinguish local configuration from live destination truth.
VisionX requires the exact current binding, opens a short-lived Discord
session, and verifies that the thread exists beneath the configured Pack forum.
The response reports its name, archive state, lock state, and applied tag
count. No Discord content or local file is changed.

## Inspect & Replace

Enter a different existing Thread ID. VisionX verifies the replacement belongs
to the configured Pack forum and is not already owned by another Pack Asset,
then atomically replaces only the local persistent binding.

The previous post is retained exactly as it is. VisionX does not move, edit,
archive, lock, or delete either post.

## Remove Binding

Removal repeats the exact current Thread ID as optimistic concurrency evidence
and atomically removes only that Pack/Asset entry. Discord is not contacted.
The Asset becomes unbound and Pack routing readiness becomes incomplete.

## Safety boundaries

- stale operator state fails before mutation;
- one Discord thread cannot be assigned to two Pack Assets;
- symlinks and unsafe binding-file replacements remain rejected;
- replacement requires live parent-forum verification;
- inspection and replacement require an explicit Discord bot token;
- local removal does not require a token;
- a forum can expose up to 20 available tags, but one post can apply at most five;
- no operation publishes a chart or creates or changes a Release.
