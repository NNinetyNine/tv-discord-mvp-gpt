import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAdminSystemValidation } from "../admin/admin-system-validation.ts";

export const VALIDATE_ADMIN_USAGE = "Usage: npx tsx src/scripts/validate-administration.ts --repository-root <path> --workspace-root <path> [--chart-downloads-root <path>]";

export interface ValidateAdminArguments {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly chartDownloadsRoot?: string;
}

export function parseValidateAdminArguments(argv: readonly string[]): ValidateAdminArguments {
  const supplied = argv.slice(2);
  const allowed = new Set(["--repository-root", "--workspace-root", "--chart-downloads-root"]);
  const values = new Map<string, string>();
  for (let index = 0; index < supplied.length; index += 2) {
    const flag = supplied[index];
    const value = supplied[index + 1];
    if (flag === undefined || !flag.startsWith("--")) throw new Error("Positional arguments are not accepted.");
    if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}.`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}.`);
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    values.set(flag, value);
  }
  const repositoryRoot = values.get("--repository-root");
  const workspaceRoot = values.get("--workspace-root");
  if (repositoryRoot === undefined || workspaceRoot === undefined) {
    throw new Error("--repository-root and --workspace-root are required.");
  }
  const chartDownloadsRoot = values.get("--chart-downloads-root");
  return Object.freeze({
    repositoryRoot,
    workspaceRoot,
    ...(chartDownloadsRoot === undefined ? {} : { chartDownloadsRoot }),
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  let options: ValidateAdminArguments;
  try {
    options = parseValidateAdminArguments(argv);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr(VALIDATE_ADMIN_USAGE);
    return 2;
  }

  try {
    const report = await runAdminSystemValidation(options);
    stdout(JSON.stringify(report, null, 2));
    return report.outcome === "passed" ? 0 : 1;
  } catch (error) {
    stderr(JSON.stringify({
      schemaVersion: 1,
      service: "visionx.admin",
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}
