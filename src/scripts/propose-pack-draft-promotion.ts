import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { proposePackDraftPromotionFile, type PackPromotionFileFailure, type ProposePackDraftPromotionFileOptions } from "../packs/pack-draft-promotion-file.ts";

export const PROPOSE_PACK_DRAFT_PROMOTION_USAGE = "Usage: npx tsx src/scripts/propose-pack-draft-promotion.ts --repository-root <path> --workspace-root <path> --request <json> --output <json>";
const FLAGS = ["--repository-root", "--workspace-root", "--request", "--output"] as const;
type Flag = (typeof FLAGS)[number];
function invalid(detail: string): PackPromotionFileFailure { return Object.freeze({ ok: false, reason: "invalid_arguments", detail }); }
export function parseProposePackDraftPromotionArguments(argv: readonly string[]): { readonly ok: true; readonly options: ProposePackDraftPromotionFileOptions } | PackPromotionFileFailure {
  const values = new Map<Flag, string>(); const supplied = argv.slice(2);
  for (let i = 0; i < supplied.length; i += 1) {
    const token = supplied[i]; if (token === undefined) continue;
    if (!token.startsWith("--")) return invalid(`positional argument is not allowed: ${token}`);
    if (!FLAGS.includes(token as Flag)) return invalid(`unknown flag: ${token}`);
    const flag = token as Flag; if (values.has(flag)) return invalid(`duplicate flag: ${flag}`);
    const value = supplied[i + 1]; if (value === undefined || value.startsWith("--")) return invalid(`missing value for flag: ${flag}`);
    values.set(flag, value); i += 1;
  }
  const missing = FLAGS.filter((flag) => !values.has(flag)); if (missing.length > 0) return invalid(`missing required flag${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  return Object.freeze({ ok: true, options: Object.freeze({ repositoryRoot: values.get("--repository-root")!, workspaceRoot: values.get("--workspace-root")!, requestPath: values.get("--request")!, outputPath: values.get("--output")! }) });
}
export async function main(argv: readonly string[] = process.argv, stdout: (text: string) => void = console.log, stderr: (text: string) => void = console.error, run: typeof proposePackDraftPromotionFile = proposePackDraftPromotionFile): Promise<number> {
  const parsed = parseProposePackDraftPromotionArguments(argv); if (!parsed.ok) { stderr(JSON.stringify(parsed, null, 2)); stderr(PROPOSE_PACK_DRAFT_PROMOTION_USAGE); return 2; }
  const result = await run(parsed.options); if (!result.ok) { stderr(JSON.stringify(result, null, 2)); return 1; }
  stdout(JSON.stringify({ ok: true, proposalSha256: result.value.sha256, proposalBytes: result.value.bytes.length, proposal: result.value.proposal }, null, 2)); return 0;
}
const invokedPath = process.argv[1]; if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; });
