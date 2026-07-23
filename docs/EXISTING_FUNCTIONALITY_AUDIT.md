# VisionX Existing Functionality Audit

Status: initial Step 537 inventory. Classification is based on the post-Step-536
source tree and is intentionally conservative. Nothing listed here is removed.

## Exposed and working in Administration

- Canonical status and source-integrity summary.
- Registry search, Pack-filter pills, exact-ID inspection, governed create/update/retire,
  validated additions-only CSV import, and canonical logo custody.
- Registry-only selection when creating a Pack.
- Pack capture sessions, Downloads-folder scanning, manual import/review,
  accepted revisions, individual revision deletion, and Pack reset.
- Standalone chart rendering and local artifact download.
- Existing-thread adoption, current-binding verification, replacement, local
  unbinding, new post provisioning, canonical logo reuse, and Pack-route checks.

## Implemented but not fully exposed

- Publishing a complete Pack through `publishPack()`.
- Resuming an interrupted Release and explicitly superseding one.
- Historical Release listing and archived chart custody.
- Existing Pack maintenance: rename, reorder members, add/remove members,
  reassign channel, reorder Packs, and delete Pack.
- Registry alias maintenance through dedicated add/remove scripts.
- Market-identity and export audits.
- Installation status reporting through the status script.

These are candidates for UI exposure or consolidation, not deletion.

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

- No UI for channel-route creation, modification, validation, or removal.
- No UI for Discord server migration, credentials, guilds, permissions, roles,
  or connection testing.
- No UI for publishing, multi-Pack selection, interrupted Release recovery, or
  Release history.
- No complete maintenance surface for existing Packs.
- CSV onboarding can set aliases for new Assets, but there is still no governed UI for editing aliases on existing Assets.
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
