# Operational Registry and Registry-owned Assets

The administration Registry is the authoritative Asset-management surface. It owns
canonical identity, display name, qualified TradingView symbol, currency, logical
channel, and the canonical logo stored by stable Asset ID. Packs select current Registry Assets; they do not ask the operator to enter a
second copy of Asset metadata.

## Why the Asset ID exists

The lowercase Asset ID is an internal, immutable reference rather than presentation
metadata. It is used by Pack membership, Pack capture and revision records, staging,
Archive image names, canonical logo custody, resolver results, and Pack/Asset Discord
thread bindings. Display name, TradingView identity, currency, and channel may change;
the ID keeps those references attached to the same Asset.

The UI suggests an ID from the TradingView symbol when a new Asset is entered, but the
operator reviews it before creation. An existing Asset ID cannot be changed. Retiring
an Asset requires first removing every Pack membership and local thread route.

## Search contract

The browser and loopback API use one explicit query contract:

```text
GET /api/v1/assets?q=<terms>&offset=<integer>&limit=<integer>
```

Only `q`, `offset`, and `limit` are accepted. Unknown and duplicate parameters are
rejected. Search is case-insensitive, requires every whitespace-separated term to
match somewhere, and covers the stable ID, display name, canonical TradingView symbol,
currency, logical channel, owning Pack IDs, and Pack display names. Results
are sorted by stable ID and paged deterministically.

Selecting **Manage** performs a second exact lookup. Older in-flight search or
selection responses cannot replace newer operator intent.

## Governed create and edit

**Add Asset** and **Edit Metadata** open a sliding Registry editor. The primary fields
are display name, qualified TradingView symbol, currency, and assigned logical channel.
The internal ID is shown as a technical field and is disabled for existing Assets.

**Review Change** generates the existing registration custody artifacts: proposal,
planning authorization, application plan, source patch, independent source review, and
application authorization. The canonical Registry is not changed during review.

**Apply Registry Change** requires an explicit confirmation and applies the reviewed
source patch only if Registry, Pack, and channel source state is still current. The
operation does not change Pack membership, render a chart, create a Release, or contact
Discord. Legacy compatibility aliases, when present in historical source, are preserved internally during canonical metadata edits but are not exposed as an operator workflow.

## Canonical logo custody

Each current Asset may have one canonical PNG at:

```text
assets/asset-logos/<assetId>.png
```

Logo creation and replacement validate the PNG, require the exact current logo hash,
write through a no-follow temporary file, atomically replace the destination, sync the
containing directory, and reread the result. Removal also requires the exact current
hash. A stale browser cannot overwrite or remove a newer logo.

Pack selection no longer asks for inline identity or logo fields. Downstream workflows
reuse the logo through the stable Asset ID. Retirement intentionally retains an
orphaned canonical logo for version-control recovery rather than silently deleting it.

## Retirement

Retirement is a separate preview-and-confirm operation. The preview binds together the
current Registry hash, Packs hash, and thread-binding hash. Application fails if any of
those sources changed, if any Pack still references the Asset, or if any local thread
route remains. The required phrase is `RETIRE <ASSET_ID>`.

## Pack and renderer selection

The Pack builder has a Registry search field and stores only ordered Asset IDs. Its
loopback preview route rejects unregistered members and member objects that attempt to
reintroduce TradingView, currency, display, channel, or logo authority. Legacy lower-
level transaction components remain for compatibility, but the administration front
door cannot create missing Assets inline.

The standalone renderer also uses search rather than a crypto-only or fixed-size
dropdown. It can select any current Registry Asset whose qualified TradingView identity
and currency satisfy the rendering contract. Selection alone does not render.

## Thread controls

**Verify Current Binding** exists to prove that an already-stored Thread ID still
points to a live thread under the configured Pack forum. It is read-only. Replacement
and removal remain separate explicit operations.

Discord forums may expose up to 20 available tags, while a forum post may apply at most
five. The UI displays that distinction and continues to enforce the applied-tag limit.

## Pack filters and bulk CSV onboarding

Step 538 adds Pack pills to Registry search. A selected pill filters by exact
canonical Pack membership and continues to combine with the existing multi-term
text query. Filtering is read-only.

The additions-only CSV importer validates the whole file before application and
supports one optional current Pack placement per new Asset and rejects alias columns. Valid
imports replace Registry and Packs through one rollback-protected transaction;
invalid rows never partially modify canonical source. See
`docs/REGISTRY_CSV_IMPORT.md` for the exact format and safeguards.
