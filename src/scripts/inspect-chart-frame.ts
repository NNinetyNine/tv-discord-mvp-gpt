import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectChartFrameFile,
  type ChartFrameFileResult,
} from "../validation/detect-chart-frame-file.ts";

interface ChartFrameReport {
  readonly results: readonly ChartFrameFileResult[];
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const suppliedPaths = argv.slice(2);
  if (suppliedPaths.length === 0) {
    stderr("Usage: npx tsx src/scripts/inspect-chart-frame.ts <image> [image ...]");
    return 2;
  }

  const results: ChartFrameFileResult[] = [];
  for (const suppliedPath of suppliedPaths) {
    results.push(await detectChartFrameFile(resolve(process.cwd(), suppliedPath)));
  }

  const report: ChartFrameReport = Object.freeze({ results: Object.freeze(results) });
  stdout(JSON.stringify(report, null, 2));
  return results.every((result) => result.detection.ok) ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
