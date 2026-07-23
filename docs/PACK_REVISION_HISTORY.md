# Pack Workspace Revision History

Accepted Pack renders are preserved as versioned Workspace evidence. Acceptance
is the confirmation gate: a preview is not a revision until the operator chooses
`ACCEPT REVISION` or `REVIEW & CONFIRM`.

## Pack Progress

Each Asset with accepted or pending evidence has a pill beside its name. Expanding
the pill shows:

- the pending render, if a folder scan queued a newer chart;
- every confirmed revision retained in the current Workspace instance;
- which confirmed revision is current and staged;
- the exact publication preview and render receipt;
- one delete control per confirmed revision.

The panel is review-only until the operator explicitly confirms or deletes an
item. Opening it does not stage, publish, release, or contact Discord.

## Individual deletion

Deleting a historical revision removes only that revision's Workspace evidence.
The current staged Analysis does not change.

Deleting the current revision restores the newest earlier confirmed revision to
staging. If no earlier revision remains, the Asset returns to Remaining Required.
Revision deletion also invalidates matching capture-session evidence so a deleted
chart cannot leave the current session falsely publication-ready.

Reset Asset and Reset Pack retain their broader meaning: they clear all revision
history in the selected Workspace scope. Archive Releases remain immutable and
are not modified by Workspace deletion or reset.

## Custody

Each confirmed revision retains:

- the original TradingView PNG;
- the rendered VisionX publication;
- the render receipt;
- Asset, Pack, timeframe, data-as-of, hashes, acceptance time, and revision
  identity.

On first load after this feature is installed, retained accepted previews are
reconciled into revision history only when they exactly match the active
Workspace revision count. Older accepted evidence from a prior reset is not
invented into the current instance.
