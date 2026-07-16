import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ImageInspectionError,
  inspectImageFiles,
  type ImageObservation,
} from "../validation/inspect-image.ts";

/**
 * Read-only developer command for observing explicitly supplied image files.
 *
 * Usage:
 *   npx tsx src/scripts/inspect-export-evidence.ts <image> [image ...]
 *
 * It performs no discovery, ingestion, acceptance, profile assignment, or state
 * mutation. JSON is emitted only after every requested file has been inspected.
 */

interface ExportEvidenceReport {
  readonly observations: readonly ImageObservation[];
}

interface ExportEvidenceFailure {
  readonly error: {
    readonly reason: ImageInspectionError["reason"];
    readonly inputPath: string;
    readonly detail: string;
  };
}

function writeJson(value: ExportEvidenceReport | ExportEvidenceFailure, write: (text: string) => void) {
  write(JSON.stringify(value, null, 2));
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  const suppliedPaths = argv.slice(2);
  if (suppliedPaths.length === 0) {
    stderr(
      "Usage: npx tsx src/scripts/inspect-export-evidence.ts <image> [image ...]",
    );
    return 2;
  }

  const inputPaths = suppliedPaths.map((path) => resolve(process.cwd(), path));

  try {
    const observations = await inspectImageFiles(inputPaths);
    writeJson({ observations }, stdout);
    return 0;
  } catch (error) {
    if (error instanceof ImageInspectionError) {
      writeJson(
        {
          error: {
            reason: error.reason,
            inputPath: error.inputPath,
            detail: error.detail,
          },
        },
        stderr,
      );
      return 1;
    }
    throw error;
  }
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
