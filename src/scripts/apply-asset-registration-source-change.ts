import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyAssetRegistrationSourceChangeFile,
  type ApplyAssetRegistrationSourceChangeFileOptions,
  type AssetRegistrationSourceApplicationFileFailure,
} from "../registry/asset-registration-source-application-file.ts";

export const APPLY_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE =
  "Usage: npx tsx src/scripts/apply-asset-registration-source-change.ts --proposal <json> --planning-authorization <json> --plan <json> --patch <patch> --source-change-receipt <json> --review <json> --application-authorization <json> --repository-root <dir> --application-receipt-output <json>";

const FLAGS = Object.freeze(["--proposal", "--planning-authorization", "--plan", "--patch", "--source-change-receipt", "--review", "--application-authorization", "--repository-root", "--application-receipt-output"] as const);
type Flag = (typeof FLAGS)[number];

export type ApplyAssetRegistrationSourceChangeArgumentResult =
  | { readonly ok: true; readonly options: ApplyAssetRegistrationSourceChangeFileOptions }
  | AssetRegistrationSourceApplicationFileFailure;

function invalidArguments(detail: string): AssetRegistrationSourceApplicationFileFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseApplyAssetRegistrationSourceChangeArguments(argv: readonly string[]): ApplyAssetRegistrationSourceChangeArgumentResult {
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
    reviewPath: values.get("--review") ?? "",
    applicationAuthorizationPath: values.get("--application-authorization") ?? "",
    repositoryRoot: values.get("--repository-root") ?? "",
    applicationReceiptOutputPath: values.get("--application-receipt-output") ?? "",
  }) });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
  run: typeof applyAssetRegistrationSourceChangeFile = applyAssetRegistrationSourceChangeFile,
): Promise<number> {
  const parsed = parseApplyAssetRegistrationSourceChangeArguments(argv);
  if (!parsed.ok) { stderr(JSON.stringify(parsed, null, 2)); stderr(APPLY_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE); return 2; }
  const result = await run(parsed.options);
  if (!result.ok) { stderr(JSON.stringify(result, null, 2)); return 1; }
  stdout(JSON.stringify(result, null, 2)); return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
