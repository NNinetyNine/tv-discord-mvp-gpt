import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  proposeAssetRegistrationFile,
  type AssetRegistrationFileFailure,
  type ProposeAssetRegistrationFileOptions,
} from "../registry/asset-registration-proposal-file.ts";

export const PROPOSE_ASSET_REGISTRATION_USAGE =
  "Usage: npx tsx src/scripts/propose-asset-registration.ts --input <json> --output <json>";

const FLAGS = Object.freeze(["--input", "--output"] as const);
type Flag = (typeof FLAGS)[number];

export type ProposeAssetRegistrationArgumentResult =
  | { readonly ok: true; readonly options: ProposeAssetRegistrationFileOptions }
  | AssetRegistrationFileFailure;

function invalidArguments(detail: string): AssetRegistrationFileFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseProposeAssetRegistrationArguments(argv: readonly string[]): ProposeAssetRegistrationArgumentResult {
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
  if (missing.length > 0) return invalidArguments(`missing required flag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  return Object.freeze({
    ok: true,
    options: Object.freeze({ inputPath: values.get("--input") ?? "", outputPath: values.get("--output") ?? "" }),
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const parsed = parseProposeAssetRegistrationArguments(argv);
  if (!parsed.ok) {
    stderr(JSON.stringify(parsed, null, 2));
    stderr(PROPOSE_ASSET_REGISTRATION_USAGE);
    return 2;
  }
  const result = await proposeAssetRegistrationFile(parsed.options);
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
