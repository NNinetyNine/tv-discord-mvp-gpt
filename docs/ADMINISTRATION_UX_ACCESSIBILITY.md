# Administration UX, responsive, and accessibility contract

Step 543 hardens the completed VisionX Administration surface for routine
operator use. It changes browser interaction and presentation only. Domain
validation, API routes, confirmation phrases, persistence, Discord operations,
and Release custody remain unchanged.

## Workspace navigation

- Every primary workspace control names its target with `aria-controls`.
- One control participates in the tab order at a time; Left/Right Arrow, Home,
  and End move between workspaces without requiring repeated Tab presses.
- The active workspace is represented in the URL hash. Reload, bookmarks, and
  browser Back/Forward restore Workspace, Threads, Server, Packs, Archive,
  Render, or Registry without adding a second router.
- Each workspace is an explicitly named region with a stable focus target.
  Hash-driven navigation announces completion through a polite live region.
- A workspace reports `aria-busy=true` while its existing loader runs. The busy
  state never grants authority, bypasses a gate, or changes source state.

## Feedback and recovery

Global errors remain assertive alerts and receive focus so the operator can act
on them. Successful outcomes use a polite status announcement and do not steal
focus. Both can be dismissed without resetting the underlying workflow.
Restricted browser storage degrades to the current in-memory Pack draft instead
of preventing Administration startup or interaction.

Registry Add/Edit and CSV Import retain their existing focus traps, Escape
handling, and focus restoration. While either modal surface is open, the
application shell is inert and hidden from the accessibility tree. Review and
apply requests expose an explicit modal busy state.

## Dense operational data

Every Administration table has an accessible caption and column-header scope.
Horizontal table containers are named keyboard-focusable regions, so narrow or
zoomed layouts can be inspected with arrow keys or trackpad scrolling without
clipping columns. Focus styling identifies the active scroll region and provides
an on-screen scroll hint.

## Responsive and platform preferences

- Touch targets retain the 44-pixel-equivalent control height established by
  the design system.
- Narrow action groups become full width rather than compressing labels.
- Navigation and main content honor device safe-area insets.
- Reduced-motion behavior from Step 542 also neutralizes the new loading sweep.
- Increased-contrast and forced-colors preferences receive explicit fallbacks.
- Capability is never hidden because of viewport width, zoom, contrast, or
  motion preference.

## Operator review matrix

Before release, review all seven workspaces at desktop, approximately 200%
zoom, tablet width, and narrow mobile width. For each surface verify:

1. keyboard entry, visible focus, and logical order;
2. loading, empty, blocked, error, success, and dismissal behavior;
3. horizontal access to every table column;
4. modal Escape, focus containment, and return focus;
5. browser reload and Back/Forward workspace restoration; and
6. reduced-motion, increased-contrast, and forced-colors behavior where the
   platform supports those preferences.

## Non-effects

Step 543 does not change Registry, Pack, route, binding, Workspace, staging, or
Release data. It does not contact Discord, alter credential handling, add a
network dependency, expose specialist scripts, or perform cleanup.
