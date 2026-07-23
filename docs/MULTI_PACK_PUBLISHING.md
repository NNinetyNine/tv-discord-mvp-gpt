# Multi-Pack Publishing

The Administration Workspace exposes one deliberate publication queue over the
existing Pack publisher. It does not introduce a second publishing engine.
Every selected Pack is still published by `publishPack()`, and interrupted
Releases are still completed by `resumeInterruptedRelease()`.

## Selection and preflight

The operator may select one Pack, a subset, or every currently ready Pack. Pack
pills show local readiness and interrupted-Release state before review.

**Review Publication** creates one exact preflight over the whole selection. It
checks, for every selected Pack:

- every canonical member has an accepted current capture;
- every member has a staged publication image;
- the active Pack Capture Session is complete, has no pending previews, and is
  inside its configured export span;
- the Pack logical channel resolves to an installation forum;
- every Pack/Asset pair has a persistent thread binding;
- an interrupted Release is either resumed separately or explicitly superseded;
- a completed Release does not still match an uncleared active Pack workspace;
- a Discord publisher is available to the Administration process.

The preview records hashes of Registry, Pack, channel, and thread-binding
sources plus a fingerprint of selected workspace captures, staged bytes,
capture-session facts, and Release state. Application re-creates the preflight
immediately before the first external action. Any drift invalidates the preview.

The exact confirmation is `PUBLISH N PACK` or `PUBLISH N PACKS`. Publishing is
not enabled until every selected Pack is ready and that current confirmation is
typed exactly.

## Delivery and truthful partial completion

The operator performs one publication action, but Discord delivery is
necessarily sequential. Selected Packs are processed in canonical Pack order,
and each Pack's analyses are posted in canonical member order.

Archive custody is created before any Discord post for a Pack. A fully
published Pack is reset independently. Unselected Packs are never reset or
changed.

There is no credible transaction that can roll back a Discord message after it
has been sent. Therefore a later external failure may leave:

- earlier selected Packs fully published;
- the failing Pack with an interrupted, resumable Release;
- later selected Packs not attempted.

The result reports all three sets explicitly. It never claims that the combined
operation was atomic after external delivery began.

Unexpected local publication failures are also attributed to the exact Pack.
Post-publication staging, capture-session, or revision-history cleanup is best-effort and
reported as a warning rather than concealing a successful Discord publication. A workspace
reset failure is reported against the exact Pack and stops later Packs. Subsequent readiness
checks detect the completed Release still matching the active captures and block a duplicate
external delivery until local workspace custody is repaired.

## Interrupted Releases

An interrupted Release has two explicit operator paths:

- **Resume** posts only analyses whose Release records still have no Discord
  message identity. It uses archive custody and snapshotted thread destinations.
- **Allow Supersede** permits a fresh Release for that Pack after the operator
  reviews the policy in the combined preflight. The historical interrupted
  record remains immutable.

Neither path silently retries or deletes Discord content.

## Custody

Administration-created Releases are stored below the configured Administration
workspace:

```text
<workspace-root>/publication/archive/<pack-id>/<release-id>/
```

This keeps publication history beside the installation-owned Pack workspace
rather than writing it into the source repository. The existing CLI publisher's
repository-root archive remains a legacy/operator surface and must not be
removed until migration and deployment consumers are consolidated.

## Non-effects of review

Selecting Packs and creating a publication preview do not:

- contact Discord;
- create a Release;
- reset Pack workspace state;
- clear staging or revision history;
- change Registry, Pack, channel, or thread-binding sources.
