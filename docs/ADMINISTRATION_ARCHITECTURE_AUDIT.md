# VisionX Administration Architecture Audit

Status: Step 537 baseline audit against commit `25224933516daf35634aed40cca3affd0bc9dcbf`.

This document records what the current system actually does before any Pack,
channel, routing, or server-configuration redesign. It is descriptive evidence,
not approval of every existing ownership decision.

## Canonical sources and installation state

| Concern | Current source of truth | Current operator surface |
| --- | --- | --- |
| Asset identity and metadata | `definitions/registry.json` | Registry search, create, edit, retire, logo management |
| Pack identity, order, membership, and Pack channel | `definitions/packs.json` | Create Pack only; existing Pack maintenance is not exposed |
| Logical channel to Discord ID | `config/channels.json` | Read-only choices/status; no configuration editor |
| Persistent Pack/Asset thread IDs | `config/asset-threads.json` | Threads inspect, bind, replace, unbind, provision, and verify |
| Current accepted Pack work | Pack workspace plus `staging/active/<assetId>.png` | Workspace capture/review/revision controls |
| Historical publication custody | `archive/<packId>/<releaseId>/` | Not exposed in the Administration UI |

The Registry and Pack files are domain definitions. Channel and thread files are
installation-specific state. Moving between Discord servers therefore requires
more than copying Registry data: channel routes, thread bindings, credentials,
and permission checks must be re-established for the destination installation.

## Stable Asset ID: required but usually secondary in the UI

The Registry key is a real internal identity, not unused metadata. It is used by:

- Pack membership entries in `definitions/packs.json`.
- Workspace capture state and one current staging filename per Asset.
- Revision storage and Pack/Asset revision lookups.
- Release records and archived image filenames such as `<assetId>.png`.
- Canonical logos under `assets/logos/<assetId>.png`.
- Persistent thread bindings keyed by Pack ID and Asset ID.
- Registry, rendering, capture, review, and routing API requests.

Changing an Asset ID would break durable references across these stores. The ID
must therefore remain immutable after creation. It should remain visible under
technical details and in conflict/error messages, but display name, TradingView
identity, currency, and assigned channel are the higher-priority operator fields.

## What Packs currently provide

Packs are not another source of Asset identity. They currently provide all of
the following operational responsibilities:

1. **Ordered membership.** `Pack.assets` defines the canonical workflow and
   publication order.
2. **Capture scope and completeness.** Workspace state is derived per Pack as
   Empty, Building, or Complete by comparing accepted captures with membership.
3. **Capture-session scope.** Downloads-folder synchronization is started and
   evaluated for one selected Pack.
4. **Validation boundary.** A Pack cannot publish while any required member is
   missing, unstaged, or otherwise blocked.
5. **Publication unit.** `publishPack()` creates one durable Release for one
   complete Pack and resets only that Pack after successful publication.
6. **Historical boundary.** Releases are listed and resumed by Pack ID and
   snapshot the Pack display, order, assets, and destinations.
7. **Discord forum route.** The Pack's logical channel resolves to the forum
   channel used by provisioning, routing verification, and publication.
8. **Persistent routing namespace.** Thread ownership is keyed by the
   Pack/Asset pair, so the same Asset ID cannot be treated as route identity
   without its Pack context.

Removing Packs now would break capture completeness, ordered publication,
Release custody/resume, and forum routing. Any future simplification needs an
explicit migration for those responsibilities and historical records.

The current Pack Builder is a **new-Pack draft**, not an editor for an existing
Pack. It persists the operator's draft in browser `localStorage`, so a draft can
outlive a Registry Asset and later display “Asset is no longer in the Registry.”
That state does not prove that a canonical Pack is corrupt; it is recoverable
browser input that should eventually gain an explicit clear/discard action.

## Confirmed channel-ownership conflict

The current model stores two related channel values:

- Every Registry Asset has `asset.channel`.
- Every Pack has `pack.channel`.

The actual Discord destination is resolved from **`pack.channel`** by publishing,
thread provisioning, adoption, and Pack-route verification. Registry Asset
channel is currently canonical metadata and a discovery/classification field;
it does not independently choose the publication destination.

This creates possible drift: an Asset may say `stocks` while a Pack containing
it routes through a different logical channel. The current loaders validate each
field against configured channel names, but do not establish one shared routing
owner across both definitions.

No field is removed in Step 537. A later architecture decision must choose one
of these models and migrate safely:

- Pack-owned route, with Asset channel treated as classification; or
- Asset-owned route, with Packs prevented from spanning incompatible routes; or
- An explicit Channel Route entity referenced consistently by both.

## Renderer eligibility: confirmed cause

The standalone renderer endpoint previously returned only Assets satisfying both:

- a qualified TradingView identity containing `market:symbol`; and
- canonical currency metadata.

The API filtered all other Registry Assets out before the browser could search
them. This is why the interface appeared Crypto-only: the 16 Crypto members are
the only fully reconciled entries in the current Registry. The browser was not
applying a Crypto Pack filter.

Step 537 keeps all Registry Assets discoverable and exposes exact reconciliation
issues. Rendering remains fail-closed until the selected Asset has both required
metadata fields.

## Registry editor lock-up: confirmed cause

The editor was nested inside `<main>`, which has its own `z-index` stacking
context. The blur overlay was generated on `body` at a higher root stacking
level. The editor's larger numeric `z-index` could not escape its parent stacking
context, so the overlay appeared while the editor remained behind it.

Step 537 moves the editor and a real backdrop to the body root, adds explicit
Cancel, backdrop, and Escape close paths, traps keyboard focus while open, and
restores focus to the invoking control on close. Failed editor preparation now
closes any partial overlay state before reporting the error.

## Publishing and migration gaps

The core publisher exists in `src/wiring/publish-pack.ts` and is reachable from
`src/scripts/publish-pack.ts`, but the current Administration UI reports
publication unavailable and does not expose Release resume/supersession.

The code already enforces important safety properties:

- complete Pack only;
- archive custody before Discord posts;
- one persistent thread per Pack/Asset pair;
- fail-closed unresolved channel or thread routes;
- honest interrupted Release records;
- resume from archived custody rather than staging.

A future bulk-publishing UI should call this existing orchestration rather than
implementing a second publisher. It must also expose interrupted Release policy,
selected-Pack atomic readiness, and server permission validation.

## Decisions for subsequent milestones

- Retain Packs until their eight current responsibilities are migrated or
  deliberately preserved.
- Keep Asset IDs immutable and technically visible, but visually secondary.
- Do not treat Asset channel and Pack channel as interchangeable until the
  ownership conflict is resolved.
- Build server configuration around installation-owned channel IDs, thread
  bindings, credentials, and permission checks.
- Reuse the existing publish/resume implementation for multi-Pack delivery.

## Step 538 Pack decision and Registry onboarding

The Pack role is now surfaced directly in the Packs page. Packs are retained as
the ordered publication-batch, readiness, Release-history, forum-route, and
Pack/Asset thread-ownership layer. They remain references to Registry Asset IDs,
not a second source of Asset metadata.

Registry Pack filters read that canonical membership without changing it. CSV
onboarding may optionally place each newly registered Asset into one existing
Pack, but the current global-disjointness invariant is enforced and documented.
The import does not resolve the separate Asset-channel versus Pack-channel route
ownership question; both values continue to be validated and preserved.

## Step 539 multi-Pack publication decision

Administration now exposes the existing Pack publisher rather than creating a
parallel delivery path. Packs remain the independent publication and Release
unit. A UI operation may select several Packs, but readiness is evaluated for
every selected Pack before the first Discord action and delivery then proceeds
in canonical Pack order.

This is **selected-set atomic readiness**, not externally atomic delivery.
Discord messages cannot be rolled back. If a later Pack fails, earlier Packs
remain truthfully published, the failing Pack retains an interrupted resumable
Release when applicable, and later Packs remain unattempted.

Administration Release custody is installation-owned at
`<workspace-root>/publication/archive`. The legacy CLI archive under the
repository root remains preserved pending server-configuration and migration
work. That future work must define archive migration, backup, and consolidation
before either custody location is retired.

## Step 540 server-configuration and migration decision

Administration now owns a governed UI for installation channel routes while
preserving the existing domain-definition boundary. `config/channels.json`
remains the logical-route to Discord-forum map and
`config/asset-threads.json` remains Pack/Asset thread custody. Registry and
Packs are not rewritten by server configuration.

The bot credential remains process environment only. The UI exposes configured
status but never the credential value. The current delivery transport is the
Discord bot gateway; webhooks are explicitly reported as unused rather than
introduced as a second secret source.

A live server test verifies bot identity, one guild, forum type, available-tag
count, bot roles, and the permissions required by current provisioning and
publication. Normal route edits fail closed when existing thread bindings depend
on a changed forum. Server Migration preserves exact before/after evidence in
the Administration workspace, applies a rollback-protected route and binding
transaction, and clears only affected Pack bindings so they can be deliberately
re-established.
Discord content is never deleted or modified by migration.

Historical Release custody remains unchanged. Administration archive migration
or consolidation is not implied by a Discord server move and remains a separate
future workflow.

## Step 541 hidden operator-function exposure

The remaining routine operator gaps identified in the Step 537 audit now have
Administration front doors without introducing duplicate domain stores:

- current Pack rename, route assignment, held-Asset membership, member order,
  Pack order, and deletion reuse the existing Pack persistence functions;
- Registry alias changes reuse the existing alias store operations and global
  identity namespace;
- historical Release browsing reads the existing installation-owned Release
  store, including custody for Packs no longer in current definitions; and
- canonical status, market-identity reconciliation, and export filename audits
  are available as read-only Server tools.

Pack maintenance is preview-bound to exact Pack source, Workspace, and thread
facts. Membership-sensitive changes require Empty Workspace state; route changes
and deletion require zero persistent bindings. Registry alias application is
bound to exact Registry source. Neither path contacts Discord or changes Release
custody.

Release archive downloads return exact stored record bytes and archived image
bytes. Archive browsing has no resume, supersession, deletion, or correction
write path. Interrupted Release recovery remains owned by Workspace publishing.

Specialist TradingView/browser and fixture scripts remain explicitly classified
as development or recovery surfaces. Their continued existence is not evidence
that they belong in primary Administration navigation, and no cleanup is
performed in this milestone.

## Step 542 presentation-system boundary

The full VisionX design language is confined to the static Administration
presentation layer. The shell keeps all existing navigation values, element
IDs, route calls, confirmation phrases, and governed boundaries. No source,
workspace, Discord, publishing, Release, migration, maintenance, or archive
behavior is coupled to a visual token or viewport state.

The responsive system removes the former fixed-width floor while preserving
access to dense operational data through reflow and horizontal table scrolling.
Decorative motion is progressive enhancement and is explicitly neutralized for
reduced-motion users. Existing local branding assets are reused; no external
font, stylesheet, script, image, telemetry, or network dependency is added.
