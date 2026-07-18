import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateAssetRegistrationSourceChangeFile,
  type AssetRegistrationSourceChangeFileFailure,
  type GenerateAssetRegistrationSourceChangeFileOptions,
} from "../registry/asset-registration-source-change-file.ts";

export const GENERATE_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE =
  "Usage: npx tsx src/scripts/generate-asset-registration-source-change.ts --proposal <json> --authorization <json> --plan <json> --patch-output <patch> --receipt-output <json>";

const FLAGS = Object.freeze([
  "--proposal",
  "--authorization",
  "--plan",
  "--patch-output",
  "--receipt-output",
] as const);
type Flag = (typeof FLAGS)[number];

export type GenerateAssetRegistrationSourceChangeArgumentResult =
  | { readonly ok: true; readonly options: GenerateAssetRegistrationSourceChangeFileOptions }
  | AssetRegistrationSourceChangeFileFailure;

function invalidArguments(detail: string): AssetRegistrationSourceChangeFileFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseGenerateAssetRegistrationSourceChangeArguments(
  argv: readonly string[],
): GenerateAssetRegistrationSourceChangeArgumentResult {
  const supplied = argv.slice(2);
  const values = new Map<Flag, string>();
  for (let index = 0; index < supplied.length; index += 1) {
    const token = supplied[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) return invalidArguments(`positional argument is not allowed: ${token}`);
    if (!FLAGS.includes(token as Flag)) return invalidArguments(`unknown flag: ${token}`);
    const flag = token as Flag;
    if (values.has(flag)) return invalidArguments(`duplicate flag: ${flag}`);
    const value = supplied[index + 1];
    if (value === undefined || value.startsWith("--")) return invalidArguments(`missing value for flag: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const missing = FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    return invalidArguments(`missing required flag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  return Object.freeze({
    ok: true,
    options: Object.freeze({
      proposalPath: values.get("--proposal") ?? "",
      authorizationPath: values.get("--authorization") ?? "",
      planPath: values.get("--plan") ?? "",
      patchOutputPath: values.get("--patch-output") ?? "",
      receiptOutputPath: values.get("--receipt-output") ?? "",
    }),
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
  run: typeof generateAssetRegistrationSourceChangeFile = generateAssetRegistrationSourceChangeFile,
): Promise<number> {
  const parsed = parseGenerateAssetRegistrationSourceChangeArguments(argv);
  if (!parsed.ok) {
    stderr(JSON.stringify(parsed, null, 2));
    stderr(GENERATE_ASSET_REGISTRATION_SOURCE_CHANGE_USAGE);
    return 2;
  }
  const result = await run(parsed.options);
  if (!result.ok) {
    stderr(JSON.stringify(result, null, 2));
    return 1;
  }
  stdout(JSON.stringify(result, null, 2));
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}
