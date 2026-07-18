import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reviewAssetRegistrationSourceChangeFile,
  type AssetRegistrationSourceChangeReviewFileFailure,
  type ReviewAssetRegistrationSourceChangeFileOptions,
} from "../registry/asset-registration-source-change-review-file.ts";

export const REVIEW_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE =
  "Usage: npx tsx src/scripts/review-asset-registration-source-change.ts --proposal <json> --planning-authorization <json> --plan <json> --patch <patch> --source-change-receipt <json> --decision <json> --output <json>";

const FLAGS = Object.freeze(["--proposal", "--planning-authorization", "--plan", "--patch", "--source-change-receipt", "--decision", "--output"] as const);
type Flag = (typeof FLAGS)[number];

export type ReviewAssetRegistrationSourceChangeArgumentResult =
  | { readonly ok: true; readonly options: ReviewAssetRegistrationSourceChangeFileOptions }
  | AssetRegistrationSourceChangeReviewFileFailure;

function invalidArguments(detail: string): AssetRegistrationSourceChangeReviewFileFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseReviewAssetRegistrationSourceChangeArguments(argv: readonly string[]): ReviewAssetRegistrationSourceChangeArgumentResult {
  const values = new Map<Flag, string>();
  const supplied = argv.slice(2);
  for (let index = 0; index < supplied.length; index += 1) {
    const token = supplied[index]; if (token === undefined) continue;
    if (!token.startsWith("--")) return invalidArguments(`positional argument is not allowed: ${token}`);
    if (!FLAGS.includes(token as Flag)) return invalidArguments(`unknown flag: ${token}`);
    const flag = token as Flag;
    if (values.has(flag)) return invalidArguments(`duplicate flag: ${flag}`);
    const value = supplied[index + 1];
    if (value === undefined || value.startsWith("--")) return invalidArguments(`missing value for flag: ${flag}`);
    values.set(flag, value); index += 1;
  }
  const missing = FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) return invalidArguments(`missing required flag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  return Object.freeze({ ok: true, options: Object.freeze({
    proposalPath: values.get("--proposal") ?? "",
    planningAuthorizationPath: values.get("--planning-authorization") ?? "",
    planPath: values.get("--plan") ?? "",
    patchPath: values.get("--patch") ?? "",
    sourceChangeReceiptPath: values.get("--source-change-receipt") ?? "",
    decisionPath: values.get("--decision") ?? "",
    outputPath: values.get("--output") ?? "",
  }) });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
  run: typeof reviewAssetRegistrationSourceChangeFile = reviewAssetRegistrationSourceChangeFile,
): Promise<number> {
  const parsed = parseReviewAssetRegistrationSourceChangeArguments(argv);
  if (!parsed.ok) { stderr(JSON.stringify(parsed, null, 2)); stderr(REVIEW_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE); return 2; }
  const result = await run(parsed.options);
  if (!result.ok) { stderr(JSON.stringify(result, null, 2)); return 1; }
  stdout(JSON.stringify(result, null, 2)); return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
