/**
 * Duplicate-grouping policy for the registry audit — pure, no I/O, no
 * dependency on the resolver, the CLI, or the full Asset model.
 *
 * A "duplicate" is 2+ export files that map to the same public identity, using
 * ONLY the resolver's public output (Option A):
 *   - resolved files group by their asset id            -> label "id (Display)"
 *   - unknown-symbol files group by their returned symbol -> label "SYMBOL"
 *   - unparseable files are never grouped (no clean public key)
 *
 * ORDERING POLICY (operator-friendly, case-insensitive, locale-PINNED):
 *   - duplicate groups are sorted by `label`
 *   - files within each group are sorted the same way
 *   - both use localeCompare with an EXPLICIT locale ("en-US") and
 *     { sensitivity: "base" }
 * The locale is pinned rather than left as `undefined` (the runtime default) so
 * ordering is DETERMINISTIC across machines — an operator's locale, a CI
 * runner's locale, and a container's C/POSIX locale would otherwise order the
 * same labels differently. Base sensitivity gives case-insensitive ordering
 * (e.g. "aapl", "msft", "ZZZ" rather than raw code-unit order "ZZZ", "aapl").
 *
 * The algorithm consumes only an id + display for resolved entries and a symbol
 * for unknown entries — so it depends on exactly those, via small local shapes,
 * not on the runtime Asset type. Callers supply values that structurally satisfy
 * these shapes (a real Asset has `id` and `display`, so it fits without import).
 */

/** The only fields the duplicate policy reads from a resolved asset. */
export interface ResolvedIdentity {
  readonly id: string;
  readonly display: string;
}

/** A resolved export file and the identity it resolved to. */
export interface ResolvedEntry {
  readonly file: string;
  readonly identity: ResolvedIdentity;
}

/** An export file whose extracted symbol did not resolve. */
export interface UnknownEntry {
  readonly file: string;
  readonly symbol: string;
}

/**
 * A duplicate group: 2+ files mapping to the same public identity.
 * `label` is "id (Display)" for resolved collisions, or the SYMBOL for
 * unknown-symbol collisions.
 */
export interface DuplicateGroup {
  readonly kind: "resolved" | "unknown";
  readonly label: string;
  readonly files: readonly string[];
}

/**
 * The single ordering comparator used for both groups and files.
 * Locale is pinned to "en-US" (not the runtime default) for cross-machine
 * deterministic ordering; base sensitivity makes it case-insensitive.
 */
function byLabel(a: string, b: string): number {
  return a.localeCompare(b, "en-US", { sensitivity: "base" });
}

export function findDuplicates(
  resolved: readonly ResolvedEntry[],
  unknown: readonly UnknownEntry[],
): DuplicateGroup[] {
  const byKey = new Map<string, { kind: "resolved" | "unknown"; label: string; files: string[] }>();

  for (const e of resolved) {
    const key = `id:${e.identity.id}`;
    const label = `${e.identity.id} (${e.identity.display})`;
    const g = byKey.get(key) ?? { kind: "resolved" as const, label, files: [] };
    g.files.push(e.file);
    byKey.set(key, g);
  }
  for (const e of unknown) {
    const key = `sym:${e.symbol.toUpperCase()}`;
    const g = byKey.get(key) ?? { kind: "unknown" as const, label: e.symbol, files: [] };
    g.files.push(e.file);
    byKey.set(key, g);
  }

  const groups: DuplicateGroup[] = [];
  for (const g of byKey.values()) {
    if (g.files.length >= 2) {
      groups.push({ kind: g.kind, label: g.label, files: [...g.files].sort(byLabel) });
    }
  }
  groups.sort((a, b) => byLabel(a.label, b.label));
  return groups;
}