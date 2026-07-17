import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reviewChartPublicationFile,
  type PublicationReviewFailure,
  type ReviewChartPublicationFileOptions,
} from "../review/publication-review-file.ts";

export const REVIEW_CHART_PUBLICATION_USAGE =
  "Usage: npx tsx src/scripts/review-chart-publication.ts --publication <png> --render-receipt <json> --review <json> --output <json> [--source <png>]";

const REQUIRED_FLAGS = Object.freeze(["--publication", "--render-receipt", "--review", "--output"] as const);
const OPTIONAL_FLAGS = Object.freeze(["--source"] as const);
type RequiredFlag = (typeof REQUIRED_FLAGS)[number];
type OptionalFlag = (typeof OPTIONAL_FLAGS)[number];
type SupportedFlag = RequiredFlag | OptionalFlag;

interface ArgumentParseSuccess {
  readonly ok: true;
  readonly options: ReviewChartPublicationFileOptions;
}

interface ArgumentParseFailure extends PublicationReviewFailure {
  readonly ok: false;
  readonly reason: "invalid_arguments";
}

export type ReviewChartPublicationArgumentResult = ArgumentParseSuccess | ArgumentParseFailure;

function invalidArguments(detail: string): ArgumentParseFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseReviewChartPublicationArguments(argv: readonly string[]): ReviewChartPublicationArgumentResult {
  const supplied = argv.slice(2);
  const values = new Map<SupportedFlag, string>();
  for (let index = 0; index < supplied.length; index += 1) {
    const token = supplied[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) return invalidArguments(`positional argument is not allowed: ${token}`);
    if (![...REQUIRED_FLAGS, ...OPTIONAL_FLAGS].includes(token as SupportedFlag)) return invalidArguments(`unknown flag: ${token}`);
    const flag = token as SupportedFlag;
    if (values.has(flag)) return invalidArguments(`duplicate flag: ${flag}`);
    const value = supplied[index + 1];
    if (value === undefined || value.startsWith("--")) return invalidArguments(`missing value for flag: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const missing = REQUIRED_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) return invalidArguments(`missing required flag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  return Object.freeze({
    ok: true,
    options: Object.freeze({
      publicationPath: values.get("--publication") ?? "",
      renderReceiptPath: values.get("--render-receipt") ?? "",
      reviewPath: values.get("--review") ?? "",
      outputPath: values.get("--output") ?? "",
      ...(values.has("--source") ? { sourcePath: values.get("--source") ?? "" } : {}),
    }),
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const parsed = parseReviewChartPublicationArguments(argv);
  if (!parsed.ok) {
    stderr(JSON.stringify(parsed, null, 2));
    stderr(REVIEW_CHART_PUBLICATION_USAGE);
    return 2;
  }
  const result = await reviewChartPublicationFile(parsed.options);
  if (!result.ok) {
    stderr(JSON.stringify(result, null, 2));
    return 1;
  }
  stdout(JSON.stringify(result, null, 2));
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        ok: false,
        reason: "finalize_failed",
        detail: error instanceof Error ? error.message : String(error),
      }, null, 2));
      process.exitCode = 1;
    });
}
