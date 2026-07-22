import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  previewChartPublicationFile,
  type PreviewChartPublicationFileOptions,
} from "../application/chart-publication-preview-file.ts";

export const PREVIEW_CHART_PUBLICATION_USAGE =
  "Usage: npm run preview-chart -- --input <TradingView PNG> --profile <JSON> --output <PNG> --receipt <JSON> [--registry <JSON>] [--channels <JSON>]";

const REQUIRED_FLAGS = Object.freeze(["--input", "--profile", "--output", "--receipt"] as const);
const OPTIONAL_FLAGS = Object.freeze(["--registry", "--channels"] as const);
type RequiredFlag = (typeof REQUIRED_FLAGS)[number];
type OptionalFlag = (typeof OPTIONAL_FLAGS)[number];
type SupportedFlag = RequiredFlag | OptionalFlag;

interface ArgumentParseSuccess {
  readonly ok: true;
  readonly options: PreviewChartPublicationFileOptions;
}

interface ArgumentParseFailure {
  readonly ok: false;
  readonly reason: "invalid_arguments";
  readonly detail: string;
}

export type PreviewChartPublicationArgumentResult =
  | ArgumentParseSuccess
  | ArgumentParseFailure;

function invalidArguments(detail: string): ArgumentParseFailure {
  return Object.freeze({ ok: false, reason: "invalid_arguments", detail });
}

export function parsePreviewChartPublicationArguments(
  argv: readonly string[],
): PreviewChartPublicationArgumentResult {
  const supplied = argv.slice(2);
  const supported = [...REQUIRED_FLAGS, ...OPTIONAL_FLAGS] as readonly SupportedFlag[];
  const values = new Map<SupportedFlag, string>();

  for (let index = 0; index < supplied.length; index += 1) {
    const token = supplied[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      return invalidArguments(`positional argument is not allowed: ${token}`);
    }
    if (!supported.includes(token as SupportedFlag)) {
      return invalidArguments(`unknown flag: ${token}`);
    }
    const flag = token as SupportedFlag;
    if (values.has(flag)) return invalidArguments(`duplicate flag: ${flag}`);
    const value = supplied[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return invalidArguments(`missing value for flag: ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }

  const missing = REQUIRED_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    return invalidArguments(
      `missing required flag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  return Object.freeze({
    ok: true,
    options: Object.freeze({
      inputPath: resolve(values.get("--input") ?? ""),
      profilePath: resolve(values.get("--profile") ?? ""),
      outputPath: resolve(values.get("--output") ?? ""),
      receiptPath: resolve(values.get("--receipt") ?? ""),
      registryPath: resolve(values.get("--registry") ?? "definitions/registry.json"),
      channelsPath: resolve(values.get("--channels") ?? "config/channels.json"),
    }),
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const parsed = parsePreviewChartPublicationArguments(argv);
  if (!parsed.ok) {
    stderr(JSON.stringify(parsed, null, 2));
    stderr(PREVIEW_CHART_PUBLICATION_USAGE);
    return 2;
  }

  const result = await previewChartPublicationFile(parsed.options);
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
        reason: "preview_failed",
        detail: error instanceof Error ? error.message : String(error),
      }, null, 2));
      process.exitCode = 1;
    });
}
