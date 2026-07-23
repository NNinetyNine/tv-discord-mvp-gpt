# Pack Capture Sessions

Pack Capture Sessions prevent a complete Pack from silently mixing current
TradingView exports with charts left over from an earlier analysis run.

## Evidence model

Starting a session records:

- the Pack identity;
- a random session identity;
- the session start timestamp;
- the configured maximum export span (60 minutes);
- every existing PNG basename, size, modification timestamp, and SHA-256.

A scan accepts only a regular, non-symlink PNG beneath the explicitly
configured Downloads folder. The TradingView filename must resolve to a
Registry Asset in the selected Pack and contain its export timestamp:

```text
<symbol>_YYYY-MM-DD_HH-MM-SS.png
```

The embedded timestamp must fall inside the current session, with a five-minute
clock tolerance. This is stronger than filesystem creation time alone: copying
an old export after the session starts does not make its embedded chart
timestamp current.

## Deterministic update rule

For each Asset, scans choose the candidate with the newest embedded export
timestamp. Filesystem modification time breaks an exact timestamp tie.

| Current evidence | Folder evidence | Result |
| --- | --- | --- |
| none | eligible current export | queue preview |
| same SHA-256 | any timestamp | no operation |
| existing candidate | older/equal export timestamp | no operation |
| existing candidate | newer timestamp and different SHA-256 | queue replacement preview |

The scan commits its candidate set only after every requested render succeeds.
If rendering fails, newly created previews are discarded and the session file
is not advanced.

## Readiness

A Pack is capture-session ready only when:

1. every required Asset has a candidate in the active session;
2. every current candidate has been explicitly accepted;
3. the accepted candidates all belong to that same session; and
4. the earliest-to-latest embedded export span is at most 60 minutes.

This milestone exposes the readiness fact but does not publish, create a
Release, contact Discord, or change Discord routing.

Confirmed renders appear in Pack Progress as versioned Workspace revisions.
See `docs/PACK_REVISION_HISTORY.md` for preview, confirmation,
single-revision deletion, and current-revision restoration behavior.

## Publication completion

A successful Administration publication resets only the published Pack, clears
its accepted capture-session candidates, and removes its Workspace revision
history after Release custody has been secured. Other Packs and their sessions
remain untouched. Staging, capture-session, or revision-history cleanup failures
are reported as warnings without concealing successful Discord delivery. A Pack
workspace reset failure is treated as a blocking publication result because the
active captures still exist; the completed Release is then used to prevent a
second external delivery until local custody is repaired.
