# VisionX Existing Functionality Audit

Status: initial Step 537 inventory. Classification is based on the post-Step-536
source tree and is intentionally conservative. Nothing listed here is removed.

## Exposed and working in Administration

- Canonical status and source-integrity summary.
- Registry search, Pack-filter pills, exact-ID inspection, governed create/update/retire,
  validated additions-only CSV import, canonical alias maintenance, and canonical logo custody.
- Registry-only selection when creating a Pack.
- Pack capture sessions, Downloads-folder scanning, manual import/review,
  accepted revisions, individual revision deletion, and Pack reset.
- Selected or all-ready Pack publication with combined preflight, exact
  confirmation, interrupted Release resume, and explicit supersession.
- Standalone chart rendering and local artifact download.
- Existing-thread adoption, current-binding verification, replacement, local
  unbinding, new post provisioning, canonical logo reuse, and Pack-route checks.
- Existing Pack rename, logical-route reassignment, held-Asset membership,
  member order, Pack order, and guarded deletion.
- Historical Release browsing and exact record/image downloads, including
  custody for Packs no longer in current definitions.
- Canonical status, market-identity reconciliation, and chart-export filename audits.

## Implemented but not fully exposed

Routine Pack maintenance, Registry aliases, historical Release custody, and the
identified status/audit surfaces are exposed as of Step 541. The remaining
non-primary functions are the specialist browser, fixture, legacy-runtime, and
scripted recovery surfaces classified below. They remain candidates for later
consolidation or documentation, not deletion.

## Script-only governed workflows

The repository includes propose, plan, review, authorize, and apply scripts for
Registry and Pack source changes. The Administration service already reuses parts
of these governed transaction layers. The scripts remain useful for recovery,
audit, automation, and non-UI operation until equivalent UI workflows and
migration procedures are proven.

## Legacy or specialist browser tooling requiring later classification

- TradingView login and chart-loading scripts.
- Button inspection and snapshot-spike tooling.
- Fixture posting and legacy runtime helpers.
- `config/tickers.json`, which `config/README.md` identifies as legacy-runtime
  data pending a runtime flip.

These may support development, evidence collection, or an older runtime. They
must not be removed before reference and deployment analysis.

## UI gaps confirmed

- Channel-route inspection, live Discord validation, governed modification, and controlled server migration are exposed in Administration. Credentials remain process-environment only; guild, forum, role, permission, and tag facts are read-only inspection evidence.
- Publication, interrupted Release recovery, and historical Release browsing
  are exposed. Archive browsing remains intentionally read-only; corrections and
  archive migration are separate future decisions.
- Existing Pack maintenance is exposed with Empty-Workspace and thread-binding gates.
- CSV onboarding and the Registry inspector both support governed aliases.
- Missing-metadata Assets were hidden from the renderer before Step 537.
- Registry Add/Edit was inaccessible because of the stacking-context defect
  fixed in Step 537.

## Controls whose value is now confirmed

**Verify Current Binding** is a read-only live Discord check for one already
bound Pack/Asset route. It confirms that the stored thread still exists under
the Pack's configured forum and reports archive, lock, and applied-tag state. It
is useful before replacement, troubleshooting, or publication; it does not
change Discord or local routing.

**Verify Pack Routing** performs the same live check across every Pack member in
canonical order and is the destination-readiness gate. It does not publish.

## Follow-up classification work

Later audits should trace each CLI script from package/deployment documentation,
identify every consumer of legacy configuration, inventory archived Release
operators, and determine which recovery functions need UI access before any
cleanup proposal is prepared.

## Step 541 operator-surface decision

Routine hidden capabilities identified by the initial audit are now exposed by
reusing existing domain implementations. Pack maintenance is not a second Pack
editor: it calls the existing Pack persistence functions after a full candidate
preview. Alias maintenance is not a second Registry: it calls existing alias
operations under exact-current Registry custody. The Archive page is a read-only
projection of the existing Administration Release store.

Status and filename audits are read-only. TradingView browser automation, button
inspection, snapshot experiments, fixture posting, and legacy-runtime helpers
remain development or recovery tools and are deliberately absent from primary
Administration navigation. No script, configuration, or archive is removed.

## Step 542 design-language decision

The Administration interface now uses one VisionX visual system across
Workspace, Threads, Server, Packs, Archive, Render, Registry, dialogs, tables,
and technical evidence. This is a presentation-only consolidation. Existing
navigation targets, element IDs, confirmations, API routes, governed write
paths, and read-only boundaries remain unchanged.

The earlier fixed minimum viewport width was removed. Responsive rules preserve
all controls by reflowing grids, stacking the Registry inspector, allowing
navigation and tables to scroll horizontally, and expanding dialogs to the
narrow viewport. Motion is reduced to effectively zero when the operating
system requests reduced motion. No hidden functionality was added or removed.

## Step 543 UX and accessibility decision

The completed operator surface now supports URL-restorable workspaces,
Left/Right/Home/End primary navigation, named workspace regions, loading
announcements, dismissible feedback, modal isolation, and keyboard-accessible
wide tables. These are interaction-shell improvements over existing functions;
they do not expose a new domain capability or duplicate a service.

Responsive review continues to preserve every control. Contrast, forced-colors,
and reduced-motion preferences have explicit fallbacks. The remaining work is
operator validation and defect correction, not architectural expansion or
cleanup.
