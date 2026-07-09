# The VisionX Constitution

**Version:** 1.0 · **Ratified:** 2026-07-09 · **Status:** Governing document

**Status.** Ratified and closed. This document consolidates every ruling settled during the
modelling phase and the Release Foundation review. It records; it does not design. Nothing in
it is speculative.

**Amendment.** The behavioural model is closed. A new concept, state, section, field, or rule
may enter only through the front door: implementation must demonstrate a genuine gap — a real
workflow behaviour that cannot be expressed — and the proposal must pass the deletion test and
the protection audit *in the message that proposes it*, before any code. A rule may not be
ratified for a case reality has not yet produced.

**Authority.** The workflow is the authority. Where this document and the workflow's proven
reality conflict, the conflict is resolved through the front door, not by silent deviation.

---

## 1. Foundational Principle

> **VisionX must never become more complicated than the operator's actual workflow. If
> implementation needs an extra concept, it must prove that the workflow genuinely needs it —
> not merely that the software would be easier to build with it.**

This principle governs everything else and authorises its own enforcement machinery:

- **The deletion test.** For any proposed noun, state, field, module, or rule: if it
  disappeared, what workflow behaviour becomes inexpressible? If the answer is "nothing," it
  does not enter. Applied retroactively, this test removed: normalization-as-translation,
  concurrent workspaces (superseded by the multi-pack amendment), Release Candidate, the
  holding area, the `abandoned` state, "Pack Catalog" as a noun, "Unassigned Analyses" as a
  section, timestamp-as-identity, the stored release `state` field, and confirmation on
  empty-Pack deletion.
- **Derived over stored.** Anything computable from facts already on record is read, never
  stored. A second encoding of an existing fact is not redundancy; it is a representable
  corruption mode.
- **Operator language over software language.** Rules are stated as what the operator is
  doing ("remove this Pack from my coverage"), never as the software's mechanics ("delete the
  workspace"). Every simplification in the modelling phase came from this reframing.
- **No rules for nonexistent cases.** A rule that cannot be tested against how the operator
  actually works can only be tested against how software likes to work — and that test always
  returns the wrong answer. Such questions are deferred (§9), not defaulted.

---

## 2. Core Ontology

### 2.1 The eight nouns

These are the complete set of domain concepts. No others exist.

| Noun | Definition |
|---|---|
| **Asset** | A market instrument the operator covers: a stable internal identity, a TradingView token (plus aliases), a display name. |
| **Pack** | A long-lived definition: an ordered set of Assets forming one publishable thesis, with a display name and a Discord channel assignment. |
| **Analysis** | One piece of finished analytical work: a chart image the operator manually framed, positioned, and exported. It attaches to an Asset. The manual positioning *is* the thesis; VisionX automates everything after export, never the analysis itself. |
| **Revision** | A replacement of an Asset's current Analysis within the same Workspace instance. Newest wins; exactly one current Analysis per Asset. |
| **Workspace** | The working state: the current *instance* of each Pack, holding its current Analyses. One Workspace, containing per-Pack workspaces. |
| **Release** | The immutable historical record of one Pack publish: the Pack as it stood, every Analysis image, and every Discord message identity. |
| **Archive** | Passive, durable custody of Releases. The historical owner of everything published, from the moment of publish. |
| **Correction** | The sole amendment path for a published Release: replace a wrong posted chart and record honestly that the correction happened. |

**Thesis** is the system's *meaning*, not a noun: VisionX manages the lifecycle of the
operator's market theses. Charts are the evidence; a Pack is a thesis's scope. "Thesis" never
appears as an object, state, or interface label.

### 2.2 The four kinds of information

Every piece of data in VisionX is exactly one of these, each with one owner:

1. **Domain definitions** — operator-owned, long-lived, editable as the operator's universe
   evolves: Assets (stored in the Registry) and Packs (stored in the pack store). These are
   the operator's truth held as data, **not** application configuration. Their recovery
   mechanism is outside the domain model (for example, version control).
2. **Working state** — operator-owned, instance-scoped, ephemeral: the Workspace (session
   captures and staged images).
3. **Historical truth** — operator-owned, immutable, self-describing: Releases in the
   Archive. Releases snapshot definitions at publish time precisely so that definitions and
   history never depend on each other.
4. **Installation configuration** — environment-owned plumbing: the Discord token, filesystem
   locations, validation thresholds. It changes when the environment changes, never when the
   thesis does, and it never appears in the operator experience.

### 2.3 Definition and instance

A Pack is a **definition**; a Workspace's per-Pack workspace is an **instance** of it. An
instance cannot exist without its definition, even conceptually — its membership, its
completeness condition, and its identity are all readings of the definition. Edits to a
definition are inherited by future instances and (with the exceptions in §5) never disturb the
in-flight one.

### 2.4 Identity and metadata

Identity is opaque and stable; metadata is fact. `packId` and `releaseId` are identities:
meaningless strings, never derived from time, names, or content, and never renamed. Display
names, channel assignments, and every timestamp are metadata. Nothing derives identity or
structure from metadata; ordering comparisons may read timestamps as facts.

---

## 3. Lifecycle

**Asset.** Created at any time, in any Workspace state (a registry write is always
permitted). Retired by removal from the Registry. An Asset has no lifecycle states of its own.

**Pack.** Created at any time. Lives as long as the operator's coverage includes it. Deleted
as a single operation on the definition (§5.4). Its past existence remains derivable from the
Archive; it is never stored as a tombstone.

**Analysis.** Comes into existence when an exported chart is imported and routed to its Asset.
It is the Asset's *current* analysis until replaced by a Revision, discarded by a reset, or
consumed into a Release by publish. An Analysis for an Asset in no Pack simply exists,
attached to its Asset, counting toward nothing (§4.6).

**Revision.** Re-importing a chart for an already-analysed Asset replaces the current
Analysis. Revisions are **counted, not browsable**: the Workspace shows a revision indicator
from Revision 2 onward; prior images are not retained by the domain (the operator's export
folder is their recovery mechanism, outside the model). Reset clears revision history.

**Workspace.** Each Pack's instance is independently **Empty → Building → Complete**:

- *Empty*: no current Analyses. Begins at instance start and after reset or publish.
- *Building*: at least one required Asset has a current Analysis.
- *Complete*: every Asset in the Pack's definition has a current Analysis.

Transitions are driven exclusively by operator acts — import, reset, publish. Never by time.
An instance ends only at publish or reset; "the current instance" and "the next instance" are
the only temporal vocabulary the model uses.

**Release.** Created at the moment publish begins, with full artifact custody, *before* any
external action. Its lifecycle is `publishing → published` and is **derived, never stored**:
`publishedAt === null` means in flight; `publishedAt !== null` means published. Two further
conditions are derived, never stored:

- **Interrupted** = an in-flight record nobody is writing.
- **Superseded** = an interrupted record for which a later-started Release of the same Pack
  exists. The old record is never modified; the operator moved past it, and the record
  sequence says so.

**Archive.** Owns a Release and its images from the moment `createRelease` completes. Nothing
ever deletes from it — not Pack deletion, not Workspace reset, not supersession.

**Correction.** (Future phase; the record format already carries its field.) A Correction
operates on a published Release: it deletes the wrong Discord message, posts the corrected
chart, and appends an honest correction entry to the Release — original analysis preserved,
new message identity captured. Discord shows the clean corrected state; the Release shows the
truth. Corrections are performed from a separate surface, never from the Workspace.

---

## 4. Behavioural Rules

**4.1 Routing by identity.** An imported chart routes to its Asset via filename resolution.
There is no manual targeting and no "active pack" gate on import: the chart lands in whichever
Pack workspace(s) the Asset belongs to. (The current codebase's single-active session predates
this amendment; see §10.)

**4.2 Import.** Every import produces a factual **receipt**: what resolved, where it landed,
whether it replaced (Revision N), or why it did not land. Unknown symbols surface in the
import flow for reconciliation.

**4.3 Completeness.** A Pack instance is Complete when, and only when, every Asset in the
Pack's definition has a current Analysis. Completeness is a set condition, never a deadline.

**4.4 Complete-only publishing.** Partial publishing **does not exist**. An incomplete Pack
is not a publishable thing; there is no confirmation that overrides this. Publish is *absent*
until a Pack is Complete (§7).

**4.5 The publish model.**

- Publish operates on any operator-chosen subset of Complete Packs. A multi-Pack publish is N
  independent Releases sharing a gesture — one Release per Pack, never a combined Release.
  Each is independently written, posted, interruptible, and resumable; the surface shows
  per-Pack truth.
- **Archive before external.** The Release record and image custody are written (in flight)
  before any Discord post. A connection failure before that point leaves zero durable state.
- Discord message identities are recorded **incrementally, as earned** — each successful post
  is written to the record before the next post begins. An interruption at any moment leaves a
  record stating exactly which messages exist. A message that posted but failed to record is
  confessed with its identity; it is never rounded away.
- The Pack workspace resets (instance ends) **only** on a fully published Release.
- Publish is a resumable **process**, not an atomic act. A fresh publish for a Pack with an
  unsuperseded interrupted Release is refused; the operator's explicit supersede decision at
  publish time is the escape — publishing fresh is itself what retires the old record from
  "live," and the old record is never touched.

**4.6 New Asset mid-Building.** Creating an Asset is permitted in any state. Its imported
Analysis attaches to the Asset normally and counts toward no Pack's completeness until the
operator adds the Asset to a Pack definition at an Empty moment — at which point the
requirement arrives already satisfied. Valid identified work is never discarded; the
completeness freeze is never violated. This is a **derived observation** ("Assets with
Analyses but no Pack"), not a state, noun, or section. It surfaces in the import receipt and
the Add-Asset flow.

**4.7 Reset.** Reset-asset discards one current Analysis; reset-pack discards a Pack
instance's work and returns it to Empty; reset-workspace discards everything (rare, kept, and
heavily confirmed with its full damage named). All resets are confirmed (§5.6). The Archive is
unreachable by any reset.

**4.8 Time is metadata, never mechanism.** VisionX has no concept of days, schedules, or
release cadence. There is no "today's Workspace." Lifecycle boundaries are operator acts
exclusively; publish resets the Workspace, time never does. Timestamps are recorded as
historical fact and displayed where relevant, but nothing behaves on them: no staleness
indicators, no cadence nudges, no date-driven grouping, no day boundaries. Lifecycle
derivation may read the *presence* of a recorded act (§3, Release), never its value.

**4.9 Cross-cutting presentation principles** (applied in §7):

- **Never rearrange.** Structure moves only by the operator's hand; content and facts update
  freely in place. The sole sanctioned attention-seizing exception is an interrupted publish.
- **Absence over disabling.** An unavailable action does not appear greyed out; it does not
  appear.
- **Facts over attention management.** VisionX reports state truthfully and lets the operator
  direct their own attention. It never nags, nudges, or prioritises on the operator's behalf.

---

## 5. Editing Rules

Both universes — Assets and Packs — are operator-owned domain data and fully editable over
the system's lifetime. **Bidirectional scaling:** growing coverage and shrinking or
reorganising it are equally first-class; the software never assumes today's definitions are
permanent. "Catalog management" is not a concept: these are ordinary edits to the definitions
the operator owns.

**5.1 Asset definitions.** Create Asset: any time, ungated. Retire Asset: an ordinary
definition edit; archived Releases referencing it are untouched.

**5.2 Pack membership and order (within a Pack).** Add, remove, and reorder Assets:
**Empty-only** — these change what "Complete" means, and the meaning of a surviving in-flight
instance must not shift underneath it. Unconfirmed direct manipulation: nothing is destroyed
and everything is re-editable.

**5.3 Pack creation, display rename, Pack reordering, channel assignment.** Ungated, in any
state, unconfirmed. None of these touches any instance's membership or completeness. A
Building Pack whose channel changes publishes to the new channel — which is precisely what the
operator meant. (Note: the current session persistence predates catalog tolerance; see §8.6.)

**5.4 Pack deletion.** One operation on one object: the removal of a definition from the
operator's coverage. The in-flight instance ceasing to exist is an **entailment**, not a
second act; no intermediate state exists. Deletion is **consent-gated, never state-gated**:

- Deleting a Pack with in-flight work confirms by naming the domain decision and its cost
  ("Remove Stocks from your coverage? 54 in-progress analyses will be discarded").
- Deleting an Empty Pack is direct manipulation — no confirmation. The definition's
  permanence is not a protected value (§6); its recovery lives outside the domain model.

Archived Releases for a deleted Pack are untouched; they are self-describing snapshots.

**5.5 `packId` is immutable.** Changing a Pack's identity is a migration, not a rename, and
the capability is **deliberately absent** — no workflow sentence requires re-identifying a
Pack rather than renaming its display or deleting-and-creating. If reality ever produces the
need, it enters through the front door as a designed migration.

**5.6 The confirmation budget.** Consent is required exactly where operator work would be
destroyed or an irreversible external act performed, and the dialog names the damage. The
confirmed set is exactly six: **publish, correction execution, reset-asset, reset-pack,
reset-workspace, delete-Pack-with-work.** Everything else is instant. No confirmation guards
a definition.

---

## 6. Protection Rules

**Derived law — the protection principle.** Every kind of value has exactly one protection
mechanism per kind of threat, matched to the value's nature:

| Value | Threat | Protection |
|---|---|---|
| **Meaning** (what "Complete" means for an in-flight instance) | shifting underneath work | the Empty-only freeze |
| **Operator work** (analyses; irreplaceable judgment) | destruction | consent that names the damage |
| **History** (Releases) | alteration or loss | immutability, amendable solely through Correction |
| **Definitions** (Assets, Packs) | loss | operator ownership; recovery outside the domain model (e.g. version control) |
| **Coherence** (references, collisions) | being wrong | fail-loud validation |
| **Durability** (records surviving failure) | system failure | per-artifact write discipline (atomic writes, incremental recording, fail-closed reads) |

Coherence and durability are separate axes: one mechanism per value **per threat**. A proposed
rule that protects something already protected on the same axis, or protects a value with a
mechanism suited to a different nature, is wrong — and the deletion test will find it.

**Rank.** This principle is **derived from** the Foundational Principle, not a peer of it:
workflow-first, applied to the question "what does each kind of value need in order to be
safe?", produces it. It is the checklist for every future confirmation, freeze, or durability
question; it is not the authority the project answers to. (It explains the confirmation-budget
deletions; it does not explain the concept deletions — those were workflow-first directly.)

---

## 7. Presentation Constitution

**7.1 Two rooms.** The Workspace (home; where the operator always starts) and the Archive
(history; visited occasionally). No dashboard, no settings-land, no third place. Pack editing
happens in the Workspace (Empty-only where §5 requires); reconciliation happens in the import
flow. Wanting a third room is a signal to re-check the model.

**7.2 Hierarchy and disclosure.** Three collapsible levels: Workspace → Packs → Analyses →
analysis detail. Progressive disclosure; the operator opens what they want to see.
**Expansion state is persistent** — the Workspace reopens as the operator left it.

**7.3 The expanded Pack view.** Two sections: **Current Analyses** (what exists, with
revision indicators from Revision 2) and **Remaining Required** (what completeness still
needs). Remaining Required **vanishes at zero** — absence over empty furniture. A reset moves
entries from Current Analyses back into Remaining Required, because that is what happened.

**7.4 Import receipt.** Every import reports its factual outcome (§4.2) at the moment it
happens, including work held for a Pack-less Asset.

**7.5 Publish picker.** Lists **only Complete Packs**. Incomplete Packs are absent from it,
not disabled in it. Publish as an action is absent until something is publishable.

**7.6 Structure versus content.** VisionX never rearranges the Workspace: Packs and Analyses
sit where the operator's definitions put them, and only operator acts move them. Facts within
that structure (counts, states, indicators, receipts) update freely. The one sanctioned
attention-seizing exception is an **interrupted publish**, which must be impossible to miss
until resolved.

**7.7 Operator-directed attention.** The interface states facts and waits. It does not
prioritise, badge, nag, or suggest what to do next.

---

## 8. Architectural Consequences

Ratified consequences of the model, already implemented in the Release Foundation:

**8.1 Releases snapshot definitions.** A Release captures the Pack's identity, display, and
full membership in canonical order as they stood at publish. History never references live
definitions; definitions evolve freely and history never flinches.

**8.2 The Archive owns its artifacts.** Creating a Release **copies** every image into the
Archive's own storage as part of the same transactional write that creates the record — a
record must never exist without custody. The Archive root is separate from staging (opposite
lifecycles never share a root).

**8.3 Releases are immutable; Correction is the single door.** No operation modifies a
written Release except the (future) Correction workflow, which appends honestly.

**8.4 Lifecycle is derived on disk.** The record stores facts (`startedAt`, `publishedAt`,
per-analysis `discordMessageId`/`postedAt`); publishing/published, interrupted, and superseded
are all read from them. No state field exists; the corresponding incoherence is
unrepresentable.

**8.5 Durability discipline.** Record writes are atomic (temp + rename); message identities
are recorded incrementally as earned; all reads fail loud on corruption — a silently skipped
record could let policy conclude "nothing interrupted" over a record it failed to read.

**8.6 Known defect, scheduled.** `persistence.ts` fails closed when Pack definitions change —
a corruption mechanism firing on legitimate definition evolution (a protection-axis
violation). Its catalog-tolerant redesign rides with the session evolution phase; definition
editing must not ship before it.

**8.7 Time and names are injected.** Orchestration receives the clock and display-name lookup
as dependencies; no store reads a clock; identity generation involves no time.

**8.8 Recorded, not yet acted on.** The `config/` directory misclassifies the two domain-data
files (registry, packs) as configuration; their home is reconsidered when the definition-
editing phase first writes to them.

---

## 9. Deferred Decisions

Deferred means *not ruled* — neither permitted nor forbidden — awaiting the stated evidence.

1. **Multi-Pack Asset routing** (an Asset belonging to two Packs). Deferred until a real
   overlapping Pack exists; today all Packs are disjoint and the model may rely on that. The
   operator's recorded prior: **one Analysis appearing in multiple Packs** (shared identity,
   not copies) — to be confirmed or corrected by reality through the front door.
2. **Persistent indicator for held work** (Assets with Analyses but no Pack). Deferred until
   use shows the operator actually loses track of such work. If needed, it enters as a small
   factual count, not a section.
3. **Pack import/export.** Deferred until any need at all exists.
4. **`packId` migration capability.** Deliberately absent (§5.5); enters only through the
   front door as a designed migration if reality demands it.

---

## 10. Implementation Sequencing

The agreed dependency order, with each ordering's reason:

1. **Release Foundation** — *complete.* First because the Release format is the one artifact
   that cannot be retrofitted: every publish made before it exists is permanently
   uncorrectable and invisible to history. Shipped: the release store (derived lifecycle,
   opaque identity, image custody, incremental message-identity recording), the session-scoped
   publisher, complete-only publish orchestration with interrupted-release detect-and-refuse
   plus the supersede escape, and the removal of partial publishing.
2. **Resume publishing** — next. Completes the interruption story the Foundation opened:
   finish an interrupted Release from its own record (post the unposted analyses, mark
   published) instead of superseding it. Everything it needs is already on disk.
3. **Session evolution** — per-Pack capture state (the multi-Pack Workspace of §4.1, replacing
   the single-active session) together with the catalog-tolerant persistence redesign
   (§8.6). These ship together because they change the same durable state.
4. **Definition editing** — the operator surfaces for §5. Depends on session evolution: the
   current positional restore turns legitimate definition edits into corruption errors.
5. **Corrections** — the workflow of §3 (Correction). Depends only on the Release format,
   which already carries what it needs; sequenced after the Workspace's own evolution because
   it is a separate surface with no dependency on the phases above beyond the Foundation.

Thereafter: the two rooms (Workspace and Archive interfaces) and the runtime flip, at which
the legacy path retires. Throughout, the CLI tools remain the proven harness — the system
stays operable during the entire build.

---

*End of Constitution. Everything above is ratified truth; everything absent from it is either
deferred (§9) or does not exist.*

---

## Amendment Log

| Version | Date | Summary |
|---|---|---|
| 1.0 | 2026-07-09 | Initial ratified Constitution |
