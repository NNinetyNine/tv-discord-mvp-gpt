# VisionX Operator Tools and Release Archive

Status: Step 541 Administration capability boundary.

## Purpose

Step 541 exposes operator functions that already existed in domain stores, audit
modules, Release custody, or specialist scripts. The UI reuses those existing
implementations rather than creating parallel definitions or a second archive.

## Current Pack maintenance

The Packs page now manages current Pack definitions through one review-bound
operation. Operators may:

- rename a Pack display label;
- reassign its existing logical channel;
- add Registry Assets that are currently held by no Pack;
- remove or reorder Pack members;
- reorder the complete Pack list; and
- delete a Pack while preserving its historical Releases.

The stable Pack ID is not editable. Membership and member-order changes, and
Pack deletion, require the Pack Workspace to be Empty. Route changes and Pack
deletion are blocked while persistent Pack/Asset thread bindings remain. Global
Asset disjointness and complete-candidate Pack validation are rechecked before
any source write.

A preview is bound to the exact current `definitions/packs.json` hash, Workspace
state, and thread-binding facts. Application requires the exact phrase
`APPLY PACK <ID>` or `DELETE PACK <ID>`. The operation calls the existing Pack
persistence functions and restores the original Pack bytes if a later step
fails. Registry, Workspace, Release custody, and Discord are non-effects.

## Canonical Registry identity

The routine Registry workflow uses one canonical qualified TradingView identity
(`MARKET:SYMBOL`) per Asset. Alias controls, alias search guidance, and alias CSV
columns are no longer exposed to operators.

Legacy alias fields and resolver functions remain internal compatibility code
until every dependency and historical source path has been audited. Step 545 does
not delete that underlying compatibility model or rewrite historical data. New
operator actions cannot create aliases.

## Release archive

The Archive page reads the installation-owned Administration Release store at
`<workspace-root>/publication/archive`. It includes Releases belonging to Packs
that no longer exist in current definitions. Operators may filter by Pack, view
published or interrupted state, inspect per-Analysis post facts, download the
exact archived `release.json`, and download archived PNG custody.

Archive browsing is read-only. It does not resume, supersede, mutate, or delete a
Release. Interrupted Release policy remains in the Workspace publication flow.
Deleting a current Pack does not delete its archive directory.

## Read-only status and audits

The Server page exposes:

- canonical Asset, Pack, and Release totals;
- market-identity and currency reconciliation gaps; and
- a read-only scan of the configured chart-downloads folder for resolved,
  unknown, unparseable, and duplicate export identities.

The export audit reads filenames only and does not alter Registry, Workspace,
staging, Release custody, or Discord.

## Specialist tools intentionally not promoted

TradingView login/chart loading, browser button inspection, snapshot-spike
experiments, fixture posting, and legacy runtime helpers remain classified as
development or recovery tools. They are not routine Administration controls and
are not removed by this milestone.
