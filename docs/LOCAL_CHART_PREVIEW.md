# Local chart-publication preview

`npm run preview-chart` is a non-publishing command. It renders one local
VisionX chart-publication PNG and receipt without staging, releasing, opening a
browser, contacting Discord, or using the network.

The command does not accept caller-authored publication metadata. Instead it:

- resolves the Asset from the TradingView export filename;
- verifies that the selected Asset matches the filename;
- reads display, qualified TradingView identity, market, symbol, and currency
  from the canonical Registry;
- derives `dataAsOf` from the strict TradingView filename timestamp;
- uses the canonical market as the visible `SOURCE` value; and
- records TradingView as chart attribution in the receipt.

The input basename must use `SYMBOL_YYYY-MM-DD_HH-MM-SS.png`. Output and receipt
paths are no-overwrite destinations.

## Standalone rendering

Standalone rendering requires only a Registry Asset. Pack membership is not
consulted, so an Asset may be rendered before it is assigned to a Pack. The
operator supplies one validated timeframe directly; no per-ticker or
per-timeframe profile file is required.

```bash
npm run preview-chart -- \
  --context standalone \
  --asset btc \
  --timeframe 1H \
  --input "$HOME/Downloads/BTCUSD_2026-07-22_18-58-01.png" \
  --output "$HOME/Downloads/btc.preview.png" \
  --receipt "$HOME/Downloads/btc.preview.receipt.json"
```

Standalone output remains local. It does not change Pack workspace state,
create a Release, look up a Discord thread, or publish anything.

### Administration UI

Start the loopback administration service with `npm run admin`, open its local
URL, and choose **RENDER**. The standalone renderer lists Registry Assets whose
qualified TradingView identity and canonical currency are complete, exposes the
shared validated timeframe list, accepts one native TradingView PNG export, and
returns an inline preview plus separate PNG and receipt downloads.

Standalone downloads preserve the imported TradingView filename stem and
append the VisionX marker. For example,
`BTCUSD_2026-07-23_10-05-00.png` downloads as
`BTCUSD_2026-07-23_10-05-00-VSX.png` with
`BTCUSD_2026-07-23_10-05-00-VSX.receipt.json`.

Each successful request receives a unique local render ID. The raw upload,
rendered publication, and receipt remain under the administration workspace;
the API exposes only the final publication and receipt. Failed renders are
discarded. This UI route never loads Pack definitions for membership, changes
Pack Workspace state, stages an artifact, creates a Release, resolves a thread,
or contacts Discord.

## Pack rendering

Pack rendering proves that the selected Asset belongs to the selected Pack and
then derives the timeframe from Pack policy:

- ordinary Packs default to `1D`;
- the `etfs` Pack defaults to `4D`.

The caller cannot override the Pack timeframe through this command. The result
includes its Pack context so the same deterministic render contract can be
reviewed and admitted to Pack staging.

All 16 Crypto Pack members have reconciled qualified identities and canonical
currencies and are available for Pack and standalone rendering. Other Packs
remain available member-by-member as their identities are reconciled.

### Pack Workspace UI

Start the loopback administration service with `npm run admin` and choose
**WORKSPACE**. The Pack Workspace shows each Pack's policy timeframe, current
state, captured count, remaining required Assets, per-Asset revision count, and
whether the current staged artifact is present.

The browser workflow is deliberately two-phase:

1. **RENDER PREVIEW** preserves the raw upload and creates a canonical Pack
   publication plus receipt in a unique review workspace. Pack progress and
   staging remain unchanged.
2. **ACCEPT REVISION** re-verifies the immutable preview evidence, validates the
   rendered publication, stages that publication, and records the Workspace
   capture/revision.

**DISCARD** removes an unaccepted preview without changing staging or Pack
progress. Once accepted, the preview is consumed and retained as accepted local
evidence, so the same review cannot be replayed. A later accepted preview for
the same Asset replaces only its current staged artifact and increments its
revision count.

Current work can also be reset from this room. **RESET** on a captured Asset
names and confirms that Asset's current revision count, removes its current
Analysis and staged publication, and returns it to Remaining Required. **RESET
PACK** names and confirms every currently captured Asset, clears that Pack's
current instance, and returns the Pack to Empty. A stale confirmation is
rejected without mutation if the reviewed revisions or captured-Asset set has
changed. Both reset operations clear current revision history only; the Archive
is unreachable and remains untouched. If staged-file cleanup cannot be
verified, the reset result says so explicitly and the UI warns the operator not
to publish until storage is inspected.

Publication remains unavailable in this UI milestone. Preview, acceptance, and
discard and reset do not create a Release, resolve a Discord thread, or contact
Discord.

### Automated Pack capture

Configure the folder containing TradingView PNG downloads when starting the
loopback administration service:

```bash
npm run admin -- \
  --repository-root "$PWD" \
  --workspace-root "$HOME/Library/Application Support/VisionX" \
  --chart-downloads-root "$HOME/Downloads"
```

In **Workspace → Automated Pack Capture**, select a Pack and start a new
analysis session **before** downloading its charts. Starting records a
SHA-256 baseline of the current folder. **Scan and Update Pack** then:

- ignores every unchanged baseline file;
- resolves eligible filenames through the Registry;
- chooses the newest embedded TradingView export timestamp per Pack Asset;
- rejects exports outside the current session clock window;
- queues a new preview only when its source hash and export timestamp are newer
  than the current candidate; and
- leaves unchanged Assets untouched, so a repeat scan creates no artificial
  revisions.

Publication readiness requires one accepted candidate for every required Pack
Asset from the same capture session. The earliest and latest embedded export
timestamps must be no more than 60 minutes apart. The current release UI still
keeps publication unavailable; this readiness result is the fail-closed gate
for the later controlled publication milestone.

The manual **Import & Review** surface remains available as a collapsible
recovery path. Manual imports do not satisfy automated capture-session
readiness because they carry no session baseline evidence.

### Pack capture and staging

The application composition root exposes `capturePackChartFromFile(...)` as
the canonical Pack artifact path. It prepares the Pack-context render, validates
the rendered PNG, copies that PNG (never the raw TradingView export) into the
asset-keyed staging slot used by `publishPack()`, and only then records the
Workspace capture/revision. The raw export and the no-overwrite rendered PNG and
receipt remain intact. Standalone renders do not call this service and therefore
cannot change staging, Workspace state, Releases, thread bindings, or Discord.

```bash
npm run preview-chart -- \
  --context pack \
  --pack crypto \
  --asset btc \
  --input "$HOME/Downloads/BTCUSD_2026-07-22_18-58-01.png" \
  --output "$HOME/Downloads/btc.pack-preview.png" \
  --receipt "$HOME/Downloads/btc.pack-preview.receipt.json"
```

The low-level `render-chart-publication.ts` command remains available for tests
that already possess complete metadata, but it should not be used as the
operator-facing Registry-backed workflow.
