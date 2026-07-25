# Step 550 — UI Fixes and Workflow Adjustments

## Scope

Step 550 tightens the Administration interface without expanding publication authority. It standardises overlays and file controls, keeps notifications visible below the header, adds an optional standalone-render watermark, fixes renderer search stacking, aligns Pack maintenance controls, moves Manual Fallback into the primary capture row, and removes the Server tab's typed confirmation phrase.

## Overlay and notification behaviour

Registry metadata, Registry CSV import, and Pack revision Quick Look use the same light blurred backdrop. The backdrop has no hover, focus, or active colour transition. Approval and error notifications are fixed below the application header and navigation, above modal backdrops, and remain visible while the current view scrolls.

## Standalone watermark policy

The standalone renderer defaults to the existing V watermark. The operator may explicitly disable it with the V WATERMARK switch. The selected state is sent as `watermark=enabled|disabled`, returned in the render result, shown in the result caption, and encoded in the receipt as watermark opacity `0` when disabled.

Watermark-free output remains standalone. Pack capture and publication continue to use the governed renderer default, whose receipt requires the canonical watermark opacity. The toggle therefore does not weaken Pack publication branding policy.

## Discord publication gates

The Pack Workspace now renders every durable local publication blocker with its code, affected Pack or Assets, and a direct action.

| Blocker | Meaning | Required action |
| --- | --- | --- |
| `discord_unavailable` | The Administration process has no usable Discord publisher session, normally because `DISCORD_BOT_TOKEN` was unavailable at startup. | Restart Administration with the bot token available, open Server, and run **Test Current Server**. |
| `pack_incomplete` | One or more Pack Assets have no accepted current revision. | Open Pack Workspace, synchronise or manually import the listed Assets, and accept the rendered revisions. |
| `missing_staged_images` | A current accepted revision exists, but its exact PNG is absent from the staging store. | Re-synchronise or accept a fresh preview for each listed Asset. |
| `channel_unresolved` | The Pack's logical channel has no usable configured Discord forum ID. | Open Server Routing, correct the logical route, review the configuration, and apply it. |
| `asset_threads_unresolved` | One or more Pack Assets have no persistent Discord thread ID. | Open Threads and adopt or provision each listed Asset thread beneath the configured forum. |
| `interrupted_release_exists` | A prior Release stopped after only some Discord posts completed. | Open Archive to inspect it, then resume it or deliberately allow a fresh superseding Release. |
| `published_release_cleanup_required` | A published Release still corresponds to active local Pack workspace state. | Verify the Release in Archive, then reset the local Pack state before starting another publication. |

Registry metadata is reported separately. Missing or conflicting render metadata prevents a new chart from being rendered, although an already accepted and staged current revision may still satisfy the local publication gate.

Discord permissions, forum ownership, available tags, required roles, and live thread health are external facts rather than durable local source state. They are not silently treated as passed. The diagnostics direct the operator to:

1. **Server → Test Current Server** for credential, guild, forum, tag, role, and permission evidence.
2. **Threads → Verify Pack Routing** for current thread existence, parent forum, archived state, locked state, and session-close health.
3. Review publication again immediately before the governed Discord action.

The publish operation still revalidates local canonical state immediately before the first external action and reports Discord rejection, partial completion, unattempted Packs, and cleanup warnings explicitly.

## Server apply gate

Server configuration still requires a valid preview, live route inspection, permission and tag evidence, stale-state protection, and the backend's exact preview-bound confirmation token. The browser no longer asks the operator to type that phrase. Pressing **Apply Server Configuration** opens a standard confirmation dialog, then submits the preview-bound token supplied by the backend.
