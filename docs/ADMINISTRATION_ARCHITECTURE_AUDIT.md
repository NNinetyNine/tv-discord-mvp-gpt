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
