import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reviewPackSourceChangeFile,
  type PackSourceChangeReviewFileFailure,
  type ReviewPackSourceChangeFileOptions,
} from "../packs/pack-source-change-review-file.ts";

export const REVIEW_PACK_SOURCE_CHANGE_USAGE = "Usage: npx tsx src/scripts/review-pack-source-change.ts --repository-root <dir> --workspace-root <dir> --promotion-request <json> --proposal <json> --planning-authorization <json> --plan <json> --patch <patch> --source-change <json> --decision <json> --output <json>";

const FLAGS = Object.freeze(["--repository-root", "--workspace-root", "--promotion-request", "--proposal", "--planning-authorization", "--plan", "--patch", "--source-change", "--decision", "--output"] as const);
type Flag = (typeof FLAGS)[number];

function invalid(detail: string): PackSourceChangeReviewFileFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseReviewPackSourceChangeArguments(argv: readonly string[]):
  | { readonly ok: true; readonly options: ReviewPackSourceChangeFileOptions }
  | PackSourceChangeReviewFileFailure {
  const values = new Map<Flag, string>();
  const supplied = argv.slice(2);
  for (let index = 0; index < supplied.length; index += 1) {
    const token = supplied[index]; if (token === undefined) continue;
    if (!token.startsWith("--")) return invalid(`positional argument is not allowed: ${token}`);
    if (!FLAGS.includes(token as Flag)) return invalid(`unknown flag: ${token}`);
    const flag = token as Flag;
    if (values.has(flag)) return invalid(`duplicate flag: ${flag}`);
    const value = supplied[index + 1];
    if (value === undefined || value.startsWith("--")) return invalid(`missing value for flag: ${flag}`);
    values.set(flag, value); index += 1;
  }
  const missing = FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) return invalid(`missing required flags: ${missing.join(", ")}`);
  return Object.freeze({ ok: true, options: Object.freeze({
    repositoryRoot: values.get("--repository-root")!,
    workspaceRoot: values.get("--workspace-root")!,
    promotionRequestPath: values.get("--promotion-request")!,
    proposalPath: values.get("--proposal")!,
    planningAuthorizationPath: values.get("--planning-authorization")!,
    planPath: values.get("--plan")!,
    patchPath: values.get("--patch")!,
    sourceChangePath: values.get("--source-change")!,
    decisionPath: values.get("--decision")!,
    outputPath: values.get("--output")!,
  }) });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (value: string) => void = console.log,
  stderr: (value: string) => void = console.error,
  run: typeof reviewPackSourceChangeFile = reviewPackSourceChangeFile,
): Promise<number> {
  const parsed = parseReviewPackSourceChangeArguments(argv);
  if (!parsed.ok) { stderr(JSON.stringify(parsed, null, 2)); stderr(REVIEW_PACK_SOURCE_CHANGE_USAGE); return 2; }
  const result = await run(parsed.options);
  if (!result.ok) { stderr(JSON.stringify(result, null, 2)); return 1; }
  stdout(JSON.stringify(result, null, 2)); return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; });
