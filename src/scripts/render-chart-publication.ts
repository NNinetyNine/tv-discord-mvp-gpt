import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderChartPublicationFile,
  type RenderChartPublicationFileOptions,
} from "../rendering/render-chart-publication-file.ts";
import type { ChartPublicationFailure } from "../rendering/render-chart-publication.ts";

export const RENDER_CHART_PUBLICATION_USAGE =
  "Usage: npx tsx src/scripts/render-chart-publication.ts --input <png> --metadata <json> --output <png> --receipt <json>";

const REQUIRED_FLAGS = Object.freeze(["--input", "--metadata", "--output", "--receipt"] as const);
type RequiredFlag = (typeof REQUIRED_FLAGS)[number];

interface ArgumentParseSuccess {
  readonly ok: true;
  readonly options: RenderChartPublicationFileOptions;
}

interface ArgumentParseFailure extends ChartPublicationFailure {
  readonly ok: false;
  readonly reason: "invalid_arguments";
}

type ArgumentParseResult = ArgumentParseSuccess | ArgumentParseFailure;

function invalidArguments(detail: string): ArgumentParseFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parseRenderChartPublicationArguments(argv: readonly string[]): ArgumentParseResult {
  const supplied = argv.slice(2);
  const values = new Map<RequiredFlag, string>();
  for (let index = 0; index < supplied.length; index += 1) {
    const token = supplied[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) return invalidArguments(`positional argument is not allowed: ${token}`);
    if (!REQUIRED_FLAGS.includes(token as RequiredFlag)) return invalidArguments(`unknown flag: ${token}`);
    const flag = token as RequiredFlag;
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
      inputPath: values.get("--input") ?? "",
      metadataPath: values.get("--metadata") ?? "",
      outputPath: values.get("--output") ?? "",
      receiptPath: values.get("--receipt") ?? "",
    }),
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const parsed = parseRenderChartPublicationArguments(argv);
  if (!parsed.ok) {
    stderr(JSON.stringify(parsed, null, 2));
    stderr(RENDER_CHART_PUBLICATION_USAGE);
    return 2;
  }

  const result = await renderChartPublicationFile(parsed.options);
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
        reason: "render_failed",
        detail: error instanceof Error ? error.message : String(error),
      }, null, 2));
      process.exitCode = 1;
    });
}
