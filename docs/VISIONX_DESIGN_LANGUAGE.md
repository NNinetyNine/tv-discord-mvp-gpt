# VisionX Administration design language

Step 542 applies one visual system to every existing Administration workflow.
It is a presentation milestone: domain services, HTTP routes, confirmations,
validation, persistence, Discord behavior, and Release custody remain unchanged.

## Visual principles

- **Near-black depth, not flat black.** The shell combines warm radial light,
  restrained grid texture, layered translucent surfaces, and subtle inner
  highlights. Gold is reserved for identity, current selection, and deliberate
  action.
- **Readable operational density.** Body copy, facts, controls, status pills,
  tables, and technical evidence are larger than the earlier compact styling.
  Condensed uppercase typography remains the hierarchy voice; longer guidance
  uses a wider system face for sustained reading.
- **Layered glass with clear boundaries.** Windows, fact cards, previews,
  inspectors, and dialogs use progressively stronger surfaces, borders, and
  shadows. Blur is enhancement only; opaque fallbacks remain present.
- **Deliberate motion.** View entrance, ambient drift, progress changes, and
  primary-action shimmer are subtle and gated behind
  `prefers-reduced-motion: no-preference`. Reduced-motion users receive no
  meaningful transition or animation duration.
- **Responsive without hiding capability.** The previous fixed 860-pixel floor
  is removed. Navigation scrolls horizontally when needed, dense grids collapse
  to two and one columns, Registry inspection becomes stacked, dialogs use the
  full narrow viewport, and tables remain horizontally inspectable rather than
  clipping columns.

## Interaction hierarchy

Primary gold actions remain reserved for the next deliberate governed step.
Outline actions are reversible review, inspection, selection, or download
operations. Destructive controls retain a distinct red treatment. Disabled
controls remain visible and legible so workflow blockers are understandable.

Focus rings use the brightest gold and are not replaced by hover treatment.
Success, warning, and blocked states retain text labels in addition to color.

## Asset and dependency boundary

The design uses the existing VisionX emblem and wordmark plus local system font
fallbacks. It adds no external font, stylesheet, script, image, analytics, or
network dependency. The static Content Security Policy remains compatible.

## Non-effects

Step 542 does not change:

- Registry, Pack, route, or thread-binding source;
- workspace, staging, or Release state;
- publishing, Discord, migration, archive, or maintenance behavior;
- route names, element IDs, API paths, confirmation phrases, or validation; or
- specialist development and recovery tools.
