import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  type FileHandle,
  lstat,
  link,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, relative, resolve, sep, join } from "node:path";

import { AdminService } from "../admin/admin-service.ts";
import {
  type PackPromotionFailureReason,
  type PackSourceApplicationPlan,
  type PackSourceChangeReceipt,
  type PackSourceProposal,
  generatePackSourceChange,
  planPackSourceChange,
  proposePackDraftPromotion,
  serializePackSourceApplicationPlan,
  serializePackSourceChangeReceipt,
  serializePackSourceProposal,
  sha256,
  validatePackDraftPromotionRequest,
} from "./pack-draft-promotion.ts";

export type PackPromotionFileFailureReason =
  | PackPromotionFailureReason
  | "invalid_arguments"
  | "unreadable_input"
  | "workspace_root_invalid"
  | "workspace_path_unsafe"
  | "source_path_unsafe"
  | "path_collision"
  | "output_already_exists"
  | "input_changed_during_operation"
  | "source_changed_during_operation"
  | "temporary_write_failed"
  | "finalize_failed";

export interface PackPromotionFileFailure {
  readonly ok: false;
  readonly reason: PackPromotionFileFailureReason;
  readonly detail: string;
}

export interface PackPromotionFileSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type PackPromotionFileResult<T> = PackPromotionFileSuccess<T> | PackPromotionFileFailure;

interface FileArtifact {
  readonly path: string;
  readonly canonicalPath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

function isFileFailure(value: FileArtifact | PackPromotionFileFailure): value is PackPromotionFileFailure {
  return "ok" in value && value.ok === false;
}
function isParseFailure(value: unknown): value is PackPromotionFileFailure {
  return typeof value === "object" && value !== null && "ok" in value && (value as { readonly ok?: unknown }).ok === false;
}

function failure(reason: PackPromotionFileFailureReason, detail: string): PackPromotionFileFailure {
  return Object.freeze({ ok: false, reason, detail });
}
function success<T>(value: T): PackPromotionFileSuccess<T> { return Object.freeze({ ok: true, value }); }
function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function readArtifact(path: string, label: string): Promise<FileArtifact | PackPromotionFileFailure> {
  const resolved = resolve(path);
  try {
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) return failure("unreadable_input", `${label} must be a regular non-symlink file`);
    const canonicalPath = await realpath(resolved);
    const bytes = await readFile(canonicalPath);
    return Object.freeze({ path: resolved, canonicalPath, bytes, sha256: sha256(bytes) });
  } catch {
    return failure("unreadable_input", `${label} could not be read`);
  }
}
function parseJson(artifact: FileArtifact, label: string): unknown | PackPromotionFileFailure {
  try { return JSON.parse(artifact.bytes.toString("utf8")) as unknown; }
  catch { return failure("unreadable_input", `${label} is not valid JSON`); }
}
async function destination(path: string, inputs: readonly FileArtifact[], otherOutputs: readonly string[] = []): Promise<{ readonly path: string; readonly directory: string } | PackPromotionFileFailure> {
  const resolved = resolve(path);
  if (inputs.some((input) => input.canonicalPath === resolved || input.path === resolved) || otherOutputs.map((value) => resolve(value)).includes(resolved)) return failure("path_collision", "Input and output paths must be distinct");
  if (await exists(resolved)) return failure("output_already_exists", "Output already exists and will not be overwritten");
  const directory = dirname(resolved);
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("workspace_path_unsafe", "Output directory must be a non-symlink directory");
    const realDirectory = await realpath(directory);
    const candidate = join(realDirectory, resolved.slice(directory.length + (directory.endsWith(sep) ? 0 : 1)));
    if (!pathInside(realDirectory, candidate)) return failure("workspace_path_unsafe", "Output path escapes its directory");
    return Object.freeze({ path: resolved, directory: realDirectory });
  } catch { return failure("workspace_path_unsafe", "Output directory is unavailable"); }
}
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try { handle = await open(directory, fsConstants.O_RDONLY); await handle.sync(); }
  catch (error) { const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""; if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(code)) throw error; }
  finally { await handle?.close(); }
}
async function writeTemp(directory: string, base: string, bytes: Buffer): Promise<string> {
  const temp = join(directory, `.${base}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return temp;
}
async function finalizeTemp(temp: string, finalPath: string): Promise<void> { await link(temp, finalPath); await unlink(temp); }
async function rehash(artifact: FileArtifact): Promise<boolean> {
  try { const bytes = await readFile(artifact.canonicalPath); return sha256(bytes) === artifact.sha256; } catch { return false; }
}
async function canonicalSourcesUnchanged(repositoryRoot: string, context: { readonly registrySha256: string; readonly packsSha256: string; readonly channelsSha256: string }): Promise<boolean> {
  const expected = [
    ["definitions/registry.json", context.registrySha256],
    ["definitions/packs.json", context.packsSha256],
    ["config/channels.json", context.channelsSha256],
  ] as const;
  try {
    for (const [relativePath, digest] of expected) {
      const path = resolve(repositoryRoot, relativePath);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (sha256(await readFile(path)) !== digest) return false;
    }
    return true;
  } catch { return false; }
}
function mapFailure(value: { readonly ok: false; readonly reason: string; readonly detail: string }): PackPromotionFileFailure {
  return failure(value.reason as PackPromotionFileFailureReason, value.detail);
}

export interface ProposePackDraftPromotionFileOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly requestPath: string;
  readonly outputPath: string;
}
export async function proposePackDraftPromotionFile(options: ProposePackDraftPromotionFileOptions): Promise<PackPromotionFileResult<{ readonly proposal: PackSourceProposal; readonly bytes: Buffer; readonly sha256: string }>> {
  const requestArtifact = await readArtifact(options.requestPath, "Promotion request"); if (isFileFailure(requestArtifact)) return requestArtifact;
  const request = requestArtifact;
  const requestValue = parseJson(request, "Promotion request"); if (isParseFailure(requestValue)) return requestValue;
  let service: AdminService;
  try { service = await AdminService.create({ repositoryRoot: options.repositoryRoot, workspaceRoot: options.workspaceRoot }); }
  catch (error) { return failure("invalid_arguments", error instanceof Error ? error.message : String(error)); }
  const context = service.promotionContext();
  const validation = validatePackDraftPromotionRequest(requestValue, context.channels); if (!validation.ok) return mapFailure(validation);
  let draft: Awaited<ReturnType<AdminService["draftArtifact"]>>;
  try { draft = await service.draftArtifact(validation.value.draftId); } catch (error) { return failure("draft_not_found", error instanceof Error ? error.message : String(error)); }
  const result = proposePackDraftPromotion({ requestValue, requestBytes: request.bytes, draftBytes: draft.bytes, context }); if (!result.ok) return mapFailure(result);
  const bytes = serializePackSourceProposal(result.value);
  const output = await destination(options.outputPath, [request]); if ("ok" in output && output.ok === false) return output;
  const dest = output as { path: string; directory: string }; let temp: string | undefined;
  try {
    if (!await rehash(request)) return failure("input_changed_during_operation", "Promotion request changed during proposal generation");
    if (!await canonicalSourcesUnchanged(service.repositoryRoot, context)) return failure("source_changed_during_operation", "Canonical source changed during proposal generation");
    temp = await writeTemp(dest.directory, "pack-proposal", bytes);
    await finalizeTemp(temp, dest.path); temp = undefined; await syncDirectory(dest.directory);
    return success(Object.freeze({ proposal: result.value, bytes, sha256: sha256(bytes) }));
  } catch { return failure("finalize_failed", "Could not finalize Pack proposal output"); }
  finally { if (temp !== undefined) await rm(temp, { force: true }); }
}

export interface PlanPackSourceChangeFileOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly requestPath: string;
  readonly proposalPath: string;
  readonly authorizationPath: string;
  readonly outputPath: string;
}
export async function planPackSourceChangeFile(options: PlanPackSourceChangeFileOptions): Promise<PackPromotionFileResult<{ readonly plan: PackSourceApplicationPlan; readonly bytes: Buffer; readonly sha256: string }>> {
  const artifacts = await Promise.all([
    readArtifact(options.requestPath, "Promotion request"), readArtifact(options.proposalPath, "Pack proposal"), readArtifact(options.authorizationPath, "Planning authorization"),
  ]);
  const firstFailure = artifacts.find(isFileFailure); if (firstFailure !== undefined) return firstFailure;
  const request = artifacts[0] as FileArtifact; const proposal = artifacts[1] as FileArtifact; const authorization = artifacts[2] as FileArtifact;
  if (new Set([request.canonicalPath, proposal.canonicalPath, authorization.canonicalPath]).size !== 3) return failure("path_collision", "Input paths must be distinct");
  const values = [parseJson(request, "Promotion request"), parseJson(proposal, "Pack proposal"), parseJson(authorization, "Planning authorization")];
  const parseFailure = values.find(isParseFailure); if (parseFailure !== undefined) return parseFailure;
  let service: AdminService; try { service = await AdminService.create({ repositoryRoot: options.repositoryRoot, workspaceRoot: options.workspaceRoot }); } catch (error) { return failure("invalid_arguments", error instanceof Error ? error.message : String(error)); }
  const context = service.promotionContext();
  const requestValidation = validatePackDraftPromotionRequest(values[0], context.channels); if (!requestValidation.ok) return mapFailure(requestValidation);
  let draft: Awaited<ReturnType<AdminService["draftArtifact"]>>; try { draft = await service.draftArtifact(requestValidation.value.draftId); } catch (error) { return failure("draft_not_found", error instanceof Error ? error.message : String(error)); }
  const result = planPackSourceChange({ requestValue: values[0], requestBytes: request.bytes, draftBytes: draft.bytes, proposalValue: values[1], proposalBytes: proposal.bytes, authorizationValue: values[2], authorizationBytes: authorization.bytes, context }); if (!result.ok) return mapFailure(result);
  const bytes = serializePackSourceApplicationPlan(result.value);
  const output = await destination(options.outputPath, [request, proposal, authorization]); if ("ok" in output && output.ok === false) return output;
  const dest = output as { path: string; directory: string }; let temp: string | undefined;
  try {
    if (!(await Promise.all([rehash(request), rehash(proposal), rehash(authorization)])).every(Boolean)) return failure("input_changed_during_operation", "An input changed during planning");
    if (!await canonicalSourcesUnchanged(service.repositoryRoot, context)) return failure("source_changed_during_operation", "Canonical source changed during planning");
    temp = await writeTemp(dest.directory, "pack-plan", bytes); await finalizeTemp(temp, dest.path); temp = undefined; await syncDirectory(dest.directory);
    return success(Object.freeze({ plan: result.value, bytes, sha256: sha256(bytes) }));
  } catch { return failure("finalize_failed", "Could not finalize Pack application plan"); }
  finally { if (temp !== undefined) await rm(temp, { force: true }); }
}

export interface GeneratePackSourceChangeFileOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly requestPath: string;
  readonly proposalPath: string;
  readonly authorizationPath: string;
  readonly planPath: string;
  readonly patchOutputPath: string;
  readonly receiptOutputPath: string;
  readonly packsAfterOutputPath?: string;
}
export async function generatePackSourceChangeFile(options: GeneratePackSourceChangeFileOptions): Promise<PackPromotionFileResult<{ readonly patch: Buffer; readonly receipt: PackSourceChangeReceipt; readonly receiptBytes: Buffer; readonly packsAfter: Buffer }>> {
  const artifacts = await Promise.all([
    readArtifact(options.requestPath, "Promotion request"), readArtifact(options.proposalPath, "Pack proposal"), readArtifact(options.authorizationPath, "Planning authorization"), readArtifact(options.planPath, "Pack application plan"),
  ]);
  const firstFailure = artifacts.find(isFileFailure); if (firstFailure !== undefined) return firstFailure;
  const request = artifacts[0] as FileArtifact; const proposal = artifacts[1] as FileArtifact; const authorization = artifacts[2] as FileArtifact; const plan = artifacts[3] as FileArtifact;
  if (new Set([request.canonicalPath, proposal.canonicalPath, authorization.canonicalPath, plan.canonicalPath]).size !== 4) return failure("path_collision", "Input paths must be distinct");
  const values = [parseJson(request, "Promotion request"), parseJson(proposal, "Pack proposal"), parseJson(authorization, "Planning authorization"), parseJson(plan, "Pack application plan")];
  const parseFailure = values.find(isParseFailure); if (parseFailure !== undefined) return parseFailure;
  let service: AdminService; try { service = await AdminService.create({ repositoryRoot: options.repositoryRoot, workspaceRoot: options.workspaceRoot }); } catch (error) { return failure("invalid_arguments", error instanceof Error ? error.message : String(error)); }
  const context = service.promotionContext();
  const requestValidation = validatePackDraftPromotionRequest(values[0], context.channels); if (!requestValidation.ok) return mapFailure(requestValidation);
  let draft: Awaited<ReturnType<AdminService["draftArtifact"]>>; try { draft = await service.draftArtifact(requestValidation.value.draftId); } catch (error) { return failure("draft_not_found", error instanceof Error ? error.message : String(error)); }
  const result = generatePackSourceChange({ requestValue: values[0], requestBytes: request.bytes, draftBytes: draft.bytes, proposalValue: values[1], proposalBytes: proposal.bytes, authorizationValue: values[2], authorizationBytes: authorization.bytes, planValue: values[3], planBytes: plan.bytes, context }); if (!result.ok) return mapFailure(result);
  const receiptBytes = serializePackSourceChangeReceipt(result.value.receipt);
  const outputPaths = [options.patchOutputPath, options.receiptOutputPath, ...(options.packsAfterOutputPath === undefined ? [] : [options.packsAfterOutputPath])];
  if (new Set(outputPaths.map((value) => resolve(value))).size !== outputPaths.length) return failure("path_collision", "Output paths must be distinct");
  const outputs = [] as { path: string; directory: string; bytes: Buffer; label: string }[];
  for (const [index, path] of outputPaths.entries()) {
    const out = await destination(path, [request, proposal, authorization, plan], outputPaths.filter((_, i) => i !== index)); if ("ok" in out && out.ok === false) return out;
    outputs.push({ ...(out as { path: string; directory: string }), bytes: index === 0 ? result.value.patch : index === 1 ? receiptBytes : result.value.packsAfter, label: index === 0 ? "pack-patch" : index === 1 ? "pack-receipt" : "packs-after" });
  }
  const temps: string[] = []; const finalized: string[] = [];
  try {
    for (const out of outputs) temps.push(await writeTemp(out.directory, out.label, out.bytes));
    if (!(await Promise.all([rehash(request), rehash(proposal), rehash(authorization), rehash(plan)])).every(Boolean)) return failure("input_changed_during_operation", "An input changed during source-change generation");
    if (!await canonicalSourcesUnchanged(service.repositoryRoot, context)) return failure("source_changed_during_operation", "Canonical source changed during source-change generation");
    for (let index = 0; index < outputs.length; index += 1) { await finalizeTemp(temps[index]!, outputs[index]!.path); finalized.push(outputs[index]!.path); }
    for (const directory of new Set(outputs.map((out) => out.directory))) await syncDirectory(directory);
    return success(Object.freeze({ patch: result.value.patch, receipt: result.value.receipt, receiptBytes, packsAfter: result.value.packsAfter }));
  } catch {
    for (const path of finalized.reverse()) await rm(path, { force: true });
    return failure("finalize_failed", "Could not finalize Pack source-change outputs transactionally");
  } finally {
    for (const temp of temps) await rm(temp, { force: true });
  }
}
