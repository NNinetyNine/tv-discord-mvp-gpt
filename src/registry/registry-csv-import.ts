import type { Pack } from "../packs/packs.ts";
import { buildPacks, PackError } from "../packs/packs.ts";
import type { Asset } from "../types.ts";
import { validatePublicationCurrency } from "./asset-market-identity.ts";
import { buildRegistry, RegistryError } from "./registry.ts";

export const REGISTRY_CSV_IMPORT_MAX_ROWS = 1000 as const;
export const REGISTRY_CSV_IMPORT_REQUIRED_HEADERS = Object.freeze([
  "id",
  "display_name",
  "tradingview_symbol",
  "currency",
  "channel",
] as const);
export const REGISTRY_CSV_IMPORT_OPTIONAL_HEADERS = Object.freeze([
  "aliases",
  "pack_ids",
] as const);

export interface RegistryCsvImportRow {
  readonly rowNumber: number;
  readonly id: string;
  readonly displayName: string;
  readonly tradingViewSymbol: string;
  readonly currency: string;
  readonly channel: string;
  readonly aliases: readonly string[];
  readonly packIds: readonly string[];
}

export interface RegistryCsvImportIssue {
  readonly code: string;
  readonly message: string;
  readonly rowNumber?: number;
  readonly field?: string;
}

export interface RegistryCsvImportCandidate {
  readonly rows: readonly RegistryCsvImportRow[];
  readonly issues: readonly RegistryCsvImportIssue[];
  readonly registryAfterBytes: Buffer | null;
  readonly packsAfterBytes: Buffer | null;
  readonly packMembershipCount: number;
}

export interface PreviewRegistryCsvImportInput {
  readonly csvText: string;
  readonly rawRegistry: Readonly<Record<string, Record<string, unknown>>>;
  readonly rawPacks: readonly unknown[];
  readonly channels: Readonly<Record<string, unknown>>;
  readonly assets: readonly Asset[];
  readonly packs: readonly Pack[];
}

function issue(code: string, message: string, rowNumber?: number, field?: string): RegistryCsvImportIssue {
  return Object.freeze({ code, message, ...(rowNumber === undefined ? {} : { rowNumber }), ...(field === undefined ? {} : { field }) });
}

function parseCsv(text: string): readonly (readonly string[])[] {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  const finishField = (): void => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  const finishRow = (): void => {
    finishField();
    if (row.some((value) => value.length > 0)) rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (afterQuote) {
      if (char === ",") {
        finishField();
        continue;
      }
      if (char === "\n") {
        finishRow();
        continue;
      }
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
        finishRow();
        continue;
      }
      throw new Error("Characters after a closing quote must be a comma or line ending.");
    }
    if (char === '"') {
      if (field.length !== 0) throw new Error("A quoted field must begin at the start of the field.");
      quoted = true;
      continue;
    }
    if (char === ",") {
      finishField();
      continue;
    }
    if (char === "\n") {
      finishRow();
      continue;
    }
    if (char === "\r" && input[index + 1] === "\n") {
      index += 1;
      finishRow();
      continue;
    }
    field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field.length > 0 || row.length > 0 || afterQuote) finishRow();
  return Object.freeze(rows.map((values) => Object.freeze(values)));
}

function splitList(value: string): readonly string[] {
  if (value === "") return Object.freeze([]);
  return Object.freeze(value.split("|").map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}

function cloneRegistry(raw: Readonly<Record<string, Record<string, unknown>>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(raw).map(([id, entry]) => [id, { ...entry }]));
}

function clonePacks(raw: readonly unknown[]): Record<string, unknown>[] {
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return {};
    const value = entry as Readonly<Record<string, unknown>>;
    return { ...value, ...(Array.isArray(value.assets) ? { assets: [...value.assets] } : {}) };
  });
}

export function previewRegistryCsvImport(input: PreviewRegistryCsvImportInput): RegistryCsvImportCandidate {
  const issues: RegistryCsvImportIssue[] = [];
  let records: readonly (readonly string[])[];
  try {
    records = parseCsv(input.csvText);
  } catch (error) {
    return Object.freeze({
      rows: Object.freeze([]),
      issues: Object.freeze([issue("invalid_csv", error instanceof Error ? error.message : String(error))]),
      registryAfterBytes: null,
      packsAfterBytes: null,
      packMembershipCount: 0,
    });
  }
  if (records.length === 0) {
    return Object.freeze({
      rows: Object.freeze([]),
      issues: Object.freeze([issue("empty_csv", "CSV must contain a header row and at least one Asset row.")]),
      registryAfterBytes: null,
      packsAfterBytes: null,
      packMembershipCount: 0,
    });
  }

  const header = (records[0] ?? []).map((value) => value.trim().toLocaleLowerCase("en-US"));
  const allowedHeaders = new Set([...REGISTRY_CSV_IMPORT_REQUIRED_HEADERS, ...REGISTRY_CSV_IMPORT_OPTIONAL_HEADERS]);
  const seenHeaders = new Set<string>();
  header.forEach((name) => {
    if (name === "") issues.push(issue("blank_header", "CSV headers must not be blank."));
    else if (!allowedHeaders.has(name as never)) issues.push(issue("unknown_header", `Unknown CSV header: ${name}.`, 1, name));
    else if (seenHeaders.has(name)) issues.push(issue("duplicate_header", `CSV header ${name} appears more than once.`, 1, name));
    seenHeaders.add(name);
  });
  for (const required of REGISTRY_CSV_IMPORT_REQUIRED_HEADERS) {
    if (!seenHeaders.has(required)) issues.push(issue("missing_header", `CSV is missing required header: ${required}.`, 1, required));
  }
  if (records.length - 1 > REGISTRY_CSV_IMPORT_MAX_ROWS) {
    issues.push(issue("too_many_rows", `CSV may contain at most ${REGISTRY_CSV_IMPORT_MAX_ROWS} Asset rows.`));
  }
  if (issues.length > 0) {
    return Object.freeze({ rows: Object.freeze([]), issues: Object.freeze(issues), registryAfterBytes: null, packsAfterBytes: null, packMembershipCount: 0 });
  }

  const indexes = new Map(header.map((name, index) => [name, index] as const));
  const existingIds = new Set(input.assets.map((asset) => asset.id));
  const existingDisplays = new Map(input.assets.map((asset) => [asset.display.toLocaleLowerCase("en-US"), asset.id] as const));
  const packIds = new Set(input.packs.map((pack) => pack.id));
  const rows: RegistryCsvImportRow[] = [];
  const importedIds = new Set<string>();
  const importedDisplays = new Map<string, string>();

  const fieldAt = (record: readonly string[], name: string): string => record[indexes.get(name) ?? -1] ?? "";
  for (let recordIndex = 1; recordIndex < records.length && recordIndex <= REGISTRY_CSV_IMPORT_MAX_ROWS; recordIndex += 1) {
    const record = records[recordIndex] ?? [];
    const rowNumber = recordIndex + 1;
    if (record.length !== header.length) {
      issues.push(issue("column_count_mismatch", `Row ${rowNumber} has ${record.length} columns; expected ${header.length}.`, rowNumber));
      continue;
    }
    const id = fieldAt(record, "id");
    const displayName = fieldAt(record, "display_name");
    const tradingViewSymbol = fieldAt(record, "tradingview_symbol");
    const currency = fieldAt(record, "currency");
    const channel = fieldAt(record, "channel");
    const aliases = splitList(fieldAt(record, "aliases"));
    const rowPackIds = splitList(fieldAt(record, "pack_ids"));

    const requiredValues = { id, display_name: displayName, tradingview_symbol: tradingViewSymbol, currency, channel };
    for (const [fieldName, value] of Object.entries(requiredValues)) {
      if (value.length === 0) issues.push(issue("missing_value", `${fieldName} is required.`, rowNumber, fieldName));
      else if (value.trim() !== value) issues.push(issue("outer_whitespace", `${fieldName} must not contain outer whitespace.`, rowNumber, fieldName));
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)) issues.push(issue("invalid_id", "id must be a lowercase slug of 1 to 64 characters.", rowNumber, "id"));
    if (displayName.length > 120 || /[\u0000-\u001F\u007F]/u.test(displayName)) issues.push(issue("invalid_display_name", "display_name must be a single-line value of at most 120 characters.", rowNumber, "display_name"));
    const tvParts = tradingViewSymbol.split(":");
    if (tradingViewSymbol.length > 96 || tvParts.length !== 2 || !tvParts[0] || !tvParts[1]) {
      issues.push(issue("invalid_tradingview_symbol", "tradingview_symbol must be a qualified MARKET:SYMBOL value.", rowNumber, "tradingview_symbol"));
    }
    const validatedCurrency = validatePublicationCurrency(currency);
    if (!validatedCurrency.ok) issues.push(issue("invalid_currency", validatedCurrency.detail, rowNumber, "currency"));
    if (!(channel in input.channels)) issues.push(issue("unknown_channel", `Channel ${channel || "(blank)"} is not configured.`, rowNumber, "channel"));
    if (existingIds.has(id)) issues.push(issue("asset_id_conflict", `Asset ID ${id} already exists in the Registry.`, rowNumber, "id"));
    if (importedIds.has(id)) issues.push(issue("duplicate_import_id", `Asset ID ${id} appears more than once in this CSV.`, rowNumber, "id"));
    importedIds.add(id);
    const displayKey = displayName.toLocaleLowerCase("en-US");
    const existingDisplayOwner = existingDisplays.get(displayKey);
    if (existingDisplayOwner !== undefined) issues.push(issue("display_conflict", `Display name ${displayName} is already used by ${existingDisplayOwner}.`, rowNumber, "display_name"));
    const importedDisplayOwner = importedDisplays.get(displayKey);
    if (importedDisplayOwner !== undefined) issues.push(issue("duplicate_import_display", `Display name ${displayName} is also used by imported Asset ${importedDisplayOwner}.`, rowNumber, "display_name"));
    importedDisplays.set(displayKey, id);
    if (new Set(aliases.map((alias) => alias.toLocaleUpperCase("en-US"))).size !== aliases.length) issues.push(issue("duplicate_alias", "aliases contains duplicate values.", rowNumber, "aliases"));
    if (aliases.some((alias) => alias.length === 0 || alias.trim() !== alias || /[\u0000-\u001F\u007F]/u.test(alias))) issues.push(issue("invalid_alias", "aliases must be non-empty single-line values separated by |.", rowNumber, "aliases"));
    if (new Set(rowPackIds).size !== rowPackIds.length) issues.push(issue("duplicate_pack_reference", "pack_ids contains duplicate Pack IDs.", rowNumber, "pack_ids"));
    if (rowPackIds.length > 1) issues.push(issue("multiple_pack_memberships_unsupported", "Current Pack architecture permits each Asset to belong to at most one Pack.", rowNumber, "pack_ids"));
    for (const packId of rowPackIds) if (!packIds.has(packId)) issues.push(issue("unknown_pack", `Pack ${packId} does not exist.`, rowNumber, "pack_ids"));

    rows.push(Object.freeze({
      rowNumber,
      id,
      displayName,
      tradingViewSymbol,
      currency: validatedCurrency.ok ? validatedCurrency.currency : currency,
      channel,
      aliases,
      packIds: rowPackIds,
    }));
  }

  if (rows.length === 0) issues.push(issue("no_asset_rows", "CSV does not contain any Asset rows."));
  if (issues.length > 0) {
    return Object.freeze({ rows: Object.freeze(rows), issues: Object.freeze(issues), registryAfterBytes: null, packsAfterBytes: null, packMembershipCount: 0 });
  }

  const candidateRegistry = cloneRegistry(input.rawRegistry);
  for (const row of rows) {
    candidateRegistry[row.id] = {
      tradingView: row.tradingViewSymbol,
      display: row.displayName,
      currency: row.currency,
      channel: row.channel,
      ...(row.aliases.length === 0 ? {} : { tradingViewAliases: [...row.aliases] }),
    };
  }
  const candidatePacks = clonePacks(input.rawPacks);
  const packById = new Map(candidatePacks.map((pack) => [String(pack.id ?? ""), pack] as const));
  let packMembershipCount = 0;
  for (const row of rows) {
    for (const packId of row.packIds) {
      const pack = packById.get(packId);
      if (pack === undefined || !Array.isArray(pack.assets)) continue;
      pack.assets.push(row.id);
      packMembershipCount += 1;
    }
  }

  try {
    const registry = buildRegistry(candidateRegistry, input.channels);
    buildPacks(candidatePacks, new Set(registry.all().map((asset) => asset.id)), new Set(Object.keys(input.channels)));
  } catch (error) {
    const detail = error instanceof RegistryError || error instanceof PackError ? error.message : String(error);
    issues.push(issue("candidate_validation_failed", detail));
  }
  if (issues.length > 0) {
    return Object.freeze({ rows: Object.freeze(rows), issues: Object.freeze(issues), registryAfterBytes: null, packsAfterBytes: null, packMembershipCount: 0 });
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    issues: Object.freeze([]),
    registryAfterBytes: Buffer.from(`${JSON.stringify(candidateRegistry, null, 2)}\n`, "utf8"),
    packsAfterBytes: Buffer.from(`${JSON.stringify(candidatePacks, null, 2)}\n`, "utf8"),
    packMembershipCount,
  });
}
