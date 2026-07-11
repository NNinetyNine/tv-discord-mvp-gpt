# VisionX Architecture

**Version:** 1.1 · **Recorded:** 2026-07-10 · **Amended:** 2026-07-11 (session evolution phase close) · **Subordinate to:** `docs/CONSTITUTION.md`

> The Constitution governs what VisionX must do. This document records how the
> current implementation satisfies it. Where they conflict, the Constitution is
> correct and this document is wrong.

---

## 1. Purpose

Three documents of record, three kinds of knowledge:

- **The Constitution** — what VisionX means and what any implementation must
  satisfy. Closed; amended only through its front door.
- **The code** — how the implementation currently works. Each module's
  doc-header states its own responsibility and the constitutional rules it
  enforces; the source is always more current than any prose about it.
- **This document** — implementation knowledge recoverable from *neither*:
  which code is permanent and which is scaffolding, which debts are deliberate
  and when they dissolve, and the structural patterns (with their triggers)
  that produced the current shape.

This document passed its own deletion test on the strength of §6 (Temporal
Ledger) and §5 (Ratified Structural Patterns) — knowledge that otherwise lives
only in conversation history. §§2–4 exist to make §§5–7 legible; they describe
what a careful reader could reconstruct from the code in hours, recorded here
so the load-bearing sections have context. If this document ever grows past
roughly a third of the Constitution's length, it has started restating rather
than mapping, and should be cut back.

## 2. Two Runtimes

The repository contains two coexisting systems. This is a strategy, not an
accident.

- **The legacy runtime** (`npm run start` and its imports, including the
  per-call publisher in `src/publish/discord.ts`) is the original working
  pipeline. It is **byte-untouched by policy**: no phase modifies it, nothing
  in the new architecture imports from it, and nothing in it imports from the
  new architecture. It exists so the operator is never without a working
  system during the build.
- **The new runtime** is everything the Constitution governs: the layered
  architecture of §3, exercised today through operator CLI scripts
  (`src/scripts/`), which serve as the proving harness while the eventual
  Workspace/Archive interfaces (Constitution §7) do not yet exist.
- **The runtime flip** is the endpoint: when the new architecture covers the
  full workflow (Constitution §10, after the two rooms), the legacy runtime
  and the CLI scripts retire together. Until then, both runtimes ship in
  every commit, and the legacy path is the fallback of record.

## 3. Layer Map

Layers, inner to outer. The dependency rule throughout: **imports point
inward only** — each layer may import from layers above it in this list,
never below, and never sideways into the legacy runtime.

| Layer | Current members | Owns | Must never |
|---|---|---|---|
| **Domain definitions & stores** | `registry/`, `packs/packs.ts`, `release/release-store.ts` | Loading/persisting the operator's definitions and historical truth; record integrity | Contain workflow policy; know about Discord, sessions, or staging as concepts |
| **Domain state** | `packs/session.ts`, `packs/persistence.ts` | Working-state lifecycle (capture, completeness, advance) and its durability | Perform I/O beyond its own file; know how images move |
| **Adapters** | `publish/discord-session.ts`, `validation/validate-image.ts`, `wiring/staging.ts`, `wiring/channels.ts` | One external reality each (gateway, image bytes, staged files, channel config) | Decide *when* they are used; import from wiring or above |
| **Wiring (orchestration)** | `wiring/capture-once.ts`, `wiring/publish-pack.ts` | Sequencing and workflow policy: gates, ordering, supersession, resume | Read clocks, env, or config directly — all reality is injected |
| **Application** | `application/capture-from-file.ts` | Use-case composition over wiring | Own state |
| **Composition root** | `composition/app.ts` | Assembling real dependencies; **the only binding of the real clock** | Decide filesystem locations or read `process.env` (the one exception: the publisher adapter owns its own token) |
| **Delivery** | `src/scripts/*.ts` | Argument parsing, invoking the app, printing, and **operator choices** (e.g. which pack to resume) | Contain orchestration; be imported by anything |

Two boundary facts worth naming because they were ratified, not inferred:
policy over release records ("interrupted", "superseded", "resumable") lives
in wiring, *above* the release store, which serves facts only; and the
delivery layer owns pack *choice* — orchestration functions take the pack as
input rather than reading "the active pack" (Constitution §4.1 has no such
concept; see §6 below for what still does).

## 4. Data at Rest

| Location | Holds | Information kind (Constitution §2.2) | Owning layer |
|---|---|---|---|
| `config/registry.json`, `config/packs.json` | Assets and Packs | Domain definitions | Domain stores (see Known Fossils: the `config/` home is a recorded misclassification) |
| `config/channels.json` | Pack→channel assignment | Domain definition (channel assignment is Pack metadata, §5.3) | Channels adapter |
| `session.json` | The single-active session's captures | Working state | `packs/persistence.ts` |
| `staging/` | Staged chart images awaiting publish | Working state | Staging adapter |
| `archive/` | Releases: records + image custody | Historical truth | Release store — **separate root from staging by ratified decision: opposite lifecycles never share a root** (Constitution §8.2) |
| `.env` | Discord token | Installation configuration | Publisher adapter |

File locations themselves are supplied by each delivery-layer entrypoint
(`process.cwd()`-relative in the scripts); the composition root takes them as
required inputs and defaults nothing.

## 5. Ratified Structural Patterns

The rules that generated the current shape. Individual instances carry
comments; the rules live here.

- **Consumer-owned dependency contracts.** A consumer declares the shape it
  needs rather than importing its dependency's exported type (wiring's
  `PublisherSessionShape` beside the adapter's `PublisherSession`; the
  capture path established the pattern). Deliberate structural duplication:
  it keeps layers independent of each other's exports.
- **The extraction trigger — final form.** A private helper is extracted to a
  shared module only when **a consumer in a *different module*** exists.
  Consumer *count* is not the trigger: the supersession helper in
  `wiring/publish-pack.ts` has two consumers (publish and resume) and remains
  private, because both live in its module. Refined twice; this is the
  settled statement.
- **The duplication threshold.** Code is duplicated until a third real
  consumer exists (3×), *and* the rule is not applied to code scheduled for
  demolition — extracting shared structure whose every consumer will be
  deleted builds permanence out of scaffolding.
- **The deliberate-duplications ledger.** (a) `SAFE_ID` charset in staging
  and the release store — second use, and importing across would invert
  layering. (b) The sequential post-and-record loops in publish and resume —
  two consumers, different sources of truth, below threshold. (c) `label()`
  in the three operator scripts — threshold technically met, extraction
  refused because all three consumers retire at the runtime flip.
- **Injected reality.** Orchestration receives the clock (`now`), the
  publisher factory, channel resolution, and display lookup as dependencies.
  The composition root is the only place the real clock is bound; adapters
  own their own external credentials; time is metadata (Constitution §4.8),
  so nothing below delivery reads it from the world.
- **Fail-loud vs. soft outcome — the sorting rule.** States the workflow
  contains become result-union variants; states only corruption can produce
  become throws (missing archive custody, session/archive disagreement).
  Result unions are per-function contracts and are not shared between
  functions, so exhaustiveness checks stay honest.

## 6. Temporal Ledger

The primary reason this document exists: which code is permanent, which
evolves with a named phase, and which is scheduled for demolition. Phase
names refer to Constitution §10.

**Permanent** (constitutional consequences in code form):
- `release/release-store.ts` — the Release format and its custody, durability,
  and derived-lifecycle discipline. The format is v1 and load-bearing forever.
- The archive layout and its separation from staging.
- `resumeInterruptedRelease`'s *contract* (pack-scoped) — born constitutional;
  session evolution changed its internals, never its signature.
- The layer map's dependency direction.

**Evolving — with the *definition editing* phase:**
- `config/` as the home of `registry.json` / `packs.json` (Constitution §8.8).

**Scheduled for demolition — when the production working-state file is
confirmed version 3:**
- The v1→v3 and v2→v3 persistence migrations in `packs/persistence.ts` (and
  their test blocks). Evidence that licenses deletion: the operator confirms
  the live `session.json` reads `"version": 3` (any post-Step-6 tool run
  rewrites it) and that no other machine or backup holds an older file.
  Hard deadline regardless: the runtime flip.

**Scheduled for demolition — at the runtime flip:**
- The legacy runtime in its entirety, including `publish/discord.ts`.
- Every operator script in `src/scripts/` (they are the proving harness, not
  product). Consequences already taken: their triplicated `label()` stays
  triplicated; no shared script utilities are to be built.

## 7. Known Fossils

Deliberate, ratified implementation debt. Each entry names the phase that
removes it; none may be "fixed" outside that phase without a front-door
decision. (Fossils 1 and 3 of v1.0 — persistence failing closed on
legitimate definition change, and "active pack" vocabulary in the publish
path — were removed by the session evolution phase and are struck.)

1. **`config/` misclassifies domain data as installation configuration**
   (Constitution §8.8, §2.2). `registry.json` and `packs.json` are
   operator-owned domain definitions living in a directory named for
   plumbing. *Removed by:* definition editing, the first phase that writes
   to them.

## 8. Maintenance

- This document is updated **only at completed phase boundaries**, in the
  same commit that closes the phase — never mid-phase, never speculatively.
- Precedence when documents disagree: **Constitution over this document;
  code over stale Architecture.** A conflict with the Constitution means this
  document is wrong; a conflict with the code means this document is stale.
  Either way, the fix flows toward this file.
- The temporal ledger and fossils list are the sections that rot fastest:
  closing session evolution, definition editing, or the runtime flip
  **requires** striking their entries here as part of the phase.

---

*Everything above traces to the current repository or to a ratified
implementation decision. Anything about the future that is not a scheduled
dissolution belongs in Constitution §9–§10, not here.*