# Step 547 Workflow Refinements

Status: implemented on the accepted Step 546 baseline.

## Registry

Canonical Registry logos remain validated PNG files with a 4 MiB byte limit and
one decoded frame. Step 547 removes the pixel-dimension range: any positive
width and height reported by the decoder are accepted, including rectangular,
very small, and very wide images.

## Threads

New forum-post provisioning treats tags as optional. VisionX may submit no
`appliedTags` field when the operator selects none. Forum inspection also
reports Discord's channel-level Require Tag flag; a tagless request is blocked
locally only when that live forum setting requires a tag.

The MANAGE action in Asset Thread Bindings now moves focus to Existing Forum
Post / Binding Management instead of the Pack Asset selector.

## Workspace

- The session-only streamlined revision-confirmation checkbox is removed.
- Valid changed files discovered by Downloads synchronization are verified and
  staged automatically.
- Capture-session completeness is informational and is no longer a publication
  blocker. Publication readiness is derived from canonical Pack completeness,
  current staging, routing, Release custody, and Discord availability.
- Pack Progress PREVIEW opens Revision Quick Look directly.
- Quick Look has separate Asset and Revision navigation. Pending candidates may
  be staged there after an automatic-staging failure; confirmed revisions may
  be deleted individually.
- Pack Progress shows `REV n` as one count pill and no longer displays `KEPT`.
- The Chart Downloads folder can be configured in Workspace. The canonical
  folder path is persisted in the administration workspace and reused on the
  next launch.

Changing the Downloads folder clears active capture-session baselines and
best-effort discards their pending previews. It does not delete confirmed
Workspace revisions, change staging, create a Release, contact Discord, or
change canonical Registry, Pack, channel, or thread-binding source.

## Server

The controlled Server Migration panel is removed from the operator interface.
The existing guarded backend recovery path remains available to preserve source
and binding safety, but ordinary use presents only Server Configuration.

## Non-effects

Step 547 does not publish a Pack, write to Discord, alter canonical Registry or
Pack membership data, change channel routing, or rewrite thread bindings.
