# Step 551 — Pack workflow and proprietary controls

Step 551 restores the selected-Pack publication model and completes the Pack-maintenance controls that were visually present but not fully wired.

## Publication scope

Publication diagnostics now evaluate only the Packs deliberately selected for the current Release. Unselected Packs remain visible as choices but do not contribute blockers, readiness totals, or error detail. The backend continues to preflight the exact selected subset in canonical Pack order and leaves unselected Pack workspaces and Releases unchanged.

## Pack maintenance

- Current Pack is a standalone selector.
- Logical Channel is populated from the current canonical channel configuration.
- Membership-only changes preserve the selected Pack's current canonical logical channel unless the operator explicitly chooses another configured route.
- Move Pack Earlier and Move Pack Later update a visible proposed-order strip and the Current Pack menu before review.
- The reviewed operation still carries the complete Pack order and remains subject to Empty-Pack and persistent-thread safeguards.

## VisionX dropdowns

Every native select is progressively enhanced into one VisionX listbox component. The canonical select remains the data owner while the component provides consistent dimensions, keyboard navigation, selected states, viewport-aware menu placement, and menu layering across all workspaces.

## Publication and confirmation review corrections

- A single reviewed Pack uses **Publish Pack**; two or more reviewed Packs use **Publish Selected Packs**.
- A valid publication preview enables the action immediately. The website uses a normal confirmation dialog and submits the preview-bound backend token itself.
- User-typed exact-confirmation inputs have been removed from publication, Pack maintenance, and Registry retirement. Backend stale-preview and authority checks remain intact.

## Layout refinements

- Manual Fallback uses the original window-header visual language rather than a pill and sits to the left of Start New Session and Sync Downloads & Update Pack.
- Renderer Registry results remain attached directly to the search field and move above it only when viewport space requires.
- Registry results stretch with the Manage inspector while pagination remains limited to 20 Assets per page.
- Packs precedes Server in primary navigation.
