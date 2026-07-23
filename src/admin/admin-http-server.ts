import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";

import { ASSET_LOGO_POLICY } from "../assets/asset-logo.ts";
import { AdminError, PACK_DRAFT_SCHEMA_VERSION, PACK_DRAFT_TYPE } from "./admin-types.ts";
import { AdminService } from "./admin-service.ts";
import { PACK_PROMOTION_ARTIFACT_NAMES, type PackPromotionArtifactName } from "./admin-promotion-workspace.ts";
import { ASSET_REGISTRATION_ARTIFACT_NAMES, type AssetRegistrationArtifactName } from "./admin-asset-registration-workspace.ts";

export const ADMIN_REQUEST_BODY_LIMIT = 65536 as const;
export const ADMIN_ASSET_LOGO_BODY_LIMIT =
  ASSET_LOGO_POLICY.maximumBytes;
export const ADMIN_STANDALONE_RENDER_BODY_LIMIT = 25 * 1024 * 1024;
export const ADMIN_REGISTRY_CSV_BODY_LIMIT = 2 * 1024 * 1024;
export const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export interface StartAdminHttpServerOptions {
  readonly service: AdminService;
  readonly host?: string;
  readonly port?: number;
}

export interface RunningAdminHttpServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

class StrictJsonParser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) { this.#text = text; }

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#value();
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) throw new Error("Unexpected trailing JSON content.");
    return value;
  }

  #peek(): string { return this.#text[this.#index] ?? ""; }
  #take(): string { return this.#text[this.#index++] ?? ""; }
  #skipWhitespace(): void { while (/\s/u.test(this.#peek())) this.#index += 1; }
  #expect(value: string): void {
    if (!this.#text.startsWith(value, this.#index)) throw new Error(`Expected ${value}.`);
    this.#index += value.length;
  }

  #value(): unknown {
    const current = this.#peek();
    if (current === "{") return this.#object();
    if (current === "[") return this.#array();
    if (current === '"') return this.#string();
    if (current === "t") { this.#expect("true"); return true; }
    if (current === "f") { this.#expect("false"); return false; }
    if (current === "n") { this.#expect("null"); return null; }
    return this.#number();
  }

  #object(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.#take();
    this.#skipWhitespace();
    if (this.#peek() === "}") { this.#take(); return result; }
    while (true) {
      if (this.#peek() !== '"') throw new Error("Object keys must be strings.");
      const key = this.#string();
      if (seen.has(key)) throw new Error(`Duplicate JSON object field: ${key}.`);
      seen.add(key);
      this.#skipWhitespace();
      if (this.#take() !== ":") throw new Error("Expected colon after object key.");
      this.#skipWhitespace();
      result[key] = this.#value();
      this.#skipWhitespace();
      const separator = this.#take();
      if (separator === "}") return result;
      if (separator !== ",") throw new Error("Expected comma or closing brace.");
      this.#skipWhitespace();
    }
  }

  #array(): unknown[] {
    const result: unknown[] = [];
    this.#take();
    this.#skipWhitespace();
    if (this.#peek() === "]") { this.#take(); return result; }
    while (true) {
      result.push(this.#value());
      this.#skipWhitespace();
      const separator = this.#take();
      if (separator === "]") return result;
      if (separator !== ",") throw new Error("Expected comma or closing bracket.");
      this.#skipWhitespace();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#take();
    let escaped = false;
    while (this.#index < this.#text.length) {
      const char = this.#take();
      if (!escaped && char === '"') {
        const token = this.#text.slice(start, this.#index);
        return JSON.parse(token) as string;
      }
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
      if (!escaped && char.charCodeAt(0) < 0x20) throw new Error("Control character in JSON string.");
    }
    throw new Error("Unterminated JSON string.");
  }

  #number(): number {
    const remaining = this.#text.slice(this.#index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remaining);
    if (match === null) throw new Error("Invalid JSON value.");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("JSON number is not finite.");
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = fields.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new AdminError("invalid_request", `${label} has unexpected or missing fields.`, 400, {
      ...(unknown.length === 0 ? {} : { unknownFields: unknown }),
      ...(missing.length === 0 ? {} : { missingFields: missing }),
    });
  }
}

function securityHeaders(response: ServerResponse, api: boolean): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", ADMIN_CSP);
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  if (api) response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response, true);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function ok(response: ServerResponse, value: unknown, status = 200): void {
  json(response, status, { ok: true, data: value });
}

function sanitizeDetails(details: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (details === undefined) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/path|root|directory|file/iu.test(key)) continue;
    result[key] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof AdminError) {
    json(response, error.status, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(sanitizeDetails(error.details) === undefined ? {} : { details: sanitizeDetails(error.details) }),
      },
    });
    return;
  }
  json(response, 500, { ok: false, error: { code: "internal_error", message: "The administration service encountered an internal error." } });
}

async function readAssetLogoBody(
  request: IncomingMessage,
): Promise<Buffer> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^image\/png(?:\s*;|$)/iu.test(contentType)
  ) {
    throw new AdminError(
      "invalid_content_type",
      "Asset logo uploads require Content-Type: image/png.",
      415,
    );
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    length += bytes.length;
    if (length > ADMIN_ASSET_LOGO_BODY_LIMIT) {
      throw new AdminError(
        "request_body_too_large",
        `Asset logo exceeds ${ADMIN_ASSET_LOGO_BODY_LIMIT} bytes.`,
        413,
      );
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

async function readChartRenderBody(
  request: IncomingMessage,
  context: "Standalone" | "Pack",
): Promise<Buffer> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^image\/png(?:\s*;|$)/iu.test(contentType)) {
    throw new AdminError(
      "invalid_content_type",
      `${context} chart uploads require Content-Type: image/png.`,
      415,
    );
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > ADMIN_STANDALONE_RENDER_BODY_LIMIT) {
      throw new AdminError(
        "request_body_too_large",
        `${context} chart exceeds ${ADMIN_STANDALONE_RENDER_BODY_LIMIT} bytes.`,
        413,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readRegistryCsvBody(request: IncomingMessage): Promise<string> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^text\/csv(?:\s*;|$)/iu.test(contentType)) {
    throw new AdminError("invalid_content_type", "Registry CSV imports require Content-Type: text/csv.", 415);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > ADMIN_REGISTRY_CSV_BODY_LIMIT) {
      throw new AdminError("request_body_too_large", `Registry CSV exceeds ${ADMIN_REGISTRY_CSV_BODY_LIMIT} bytes.`, 413);
    }
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new AdminError("invalid_request", "Registry CSV is not valid UTF-8.");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new AdminError("invalid_content_type", "JSON writes require Content-Type: application/json.", 415);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > ADMIN_REQUEST_BODY_LIMIT) {
      throw new AdminError("request_body_too_large", `Request body exceeds ${ADMIN_REQUEST_BODY_LIMIT} bytes.`, 413);
    }
    chunks.push(bytes);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new AdminError("invalid_json", "Request body is not valid UTF-8.");
  }
  try {
    return new StrictJsonParser(text).parse();
  } catch (error) {
    throw new AdminError("invalid_json", error instanceof Error ? error.message : "Request body is not valid JSON.");
  }
}

function assertSameOriginForWrite(request: IncomingMessage, origin: string): void {
  if (!new Set(["POST", "PUT", "DELETE", "PATCH"]).has(request.method ?? "")) return;
  const supplied = request.headers.origin;
  if (supplied !== undefined && supplied !== origin) {
    throw new AdminError("origin_rejected", "Cross-origin state-changing requests are not accepted.", 403);
  }
}

function safePathname(rawUrl: string): { readonly url: URL; readonly decodedPathname: string } {
  let url: URL;
  try { url = new URL(rawUrl, "http://127.0.0.1"); }
  catch { throw new AdminError("invalid_request", "Request URL is invalid."); }
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { throw new AdminError("invalid_request", "Request path encoding is invalid."); }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new AdminError("route_not_found", "Route was not found.", 404);
  }
  return { url, decodedPathname: decoded };
}

function parseInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new AdminError("invalid_request", "Pagination values must be nonnegative integers.");
  return Number(value);
}

function exactSearchParameters(url: URL, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!permitted.has(key)) throw new AdminError("invalid_request", `${label} contains an unknown parameter: ${key}.`);
    if (seen.has(key)) throw new AdminError("invalid_request", `${label} contains duplicate parameter: ${key}.`);
    seen.add(key);
  }
  for (const key of allowed) {
    if (!seen.has(key)) throw new AdminError("invalid_request", `${label} requires parameter: ${key}.`);
  }
}

function optionalSearchParameters(url: URL, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!permitted.has(key)) throw new AdminError("invalid_request", `${label} contains an unknown parameter: ${key}.`);
    if (seen.has(key)) throw new AdminError("invalid_request", `${label} contains duplicate parameter: ${key}.`);
    seen.add(key);
  }
}

function binaryArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  bytes: Buffer,
  artifact: "publication.png" | "receipt.json",
): void {
  securityHeaders(response, true);
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    artifact === "publication.png" ? "image/png" : "application/json; charset=utf-8",
  );
  response.setHeader(
    "Content-Disposition",
    `${artifact === "publication.png" ? "inline" : "attachment"}; filename="visionx-${artifact}"`,
  );
  response.setHeader("Content-Length", String(bytes.length));
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function inlinePng(
  request: IncomingMessage,
  response: ServerResponse,
  bytes: Buffer,
  filename: string,
): void {
  securityHeaders(response, true);
  response.statusCode = 200;
  response.setHeader("Content-Type", "image/png");
  response.setHeader("Content-Disposition", `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/gu, "-")}"`);
  response.setHeader("Content-Length", String(bytes.length));
  response.end(request.method === "HEAD" ? undefined : bytes);
}

async function serveStatic(response: ServerResponse, path: string): Promise<void> {
  const route = path === "/" ? "/index.html" : path;
  const staticAssets = new Map<string, URL>([
    ["/index.html", new URL("../admin-ui/index.html", import.meta.url)],
    ["/styles.css", new URL("../admin-ui/styles.css", import.meta.url)],
    ["/app.js", new URL("../admin-ui/app.js", import.meta.url)],
    ["/visionx-emblem.png", new URL("../../assets/branding/visionx-emblem.png", import.meta.url)],
    ["/visionx-wordmark.png", new URL("../../assets/branding/visionx-wordmark.png", import.meta.url)],
  ]);
  const assetUrl = staticAssets.get(route);
  if (assetUrl === undefined) {
    throw new AdminError("route_not_found", "Route was not found.", 404);
  }
  const bytes = await readFile(fileURLToPath(assetUrl));
  securityHeaders(response, false);
  response.statusCode = 200;
  const extension = extname(route);
  response.setHeader(
    "Content-Type",
    extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".png"
          ? "image/png"
          : "text/javascript; charset=utf-8",
  );
  response.setHeader("Cache-Control", "no-cache");
  response.end(bytes);
}

async function routeApi(
  request: IncomingMessage,
  response: ServerResponse,
  service: AdminService,
  url: URL,
  pathname: string,
): Promise<void> {
  const method = request.method ?? "GET";
  if (pathname === "/api/v1/status" && method === "GET") return ok(response, service.status());
  if (pathname === "/api/v1/channels" && method === "GET") return ok(response, { schemaVersion: 1, logicalChannels: service.logicalChannels() });
  if (pathname === "/api/v1/thread-management") {
    if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    return ok(response, await service.threadManagementState());
  }
  const routingVerification = /^\/api\/v1\/thread-management\/packs\/([^/]+)\/verify$/u.exec(pathname);
  if (routingVerification !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Pack routing verification request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Pack routing verification body must be an object.");
    exactFields(body, ["confirmation"], "Pack routing verification body");
    if (typeof body.confirmation !== "string") {
      throw new AdminError("invalid_request", "Pack routing verification confirmation must be a string.");
    }
    return ok(response, await service.verifyPackThreadRouting({
      packId: routingVerification[1] ?? "",
      confirmation: body.confirmation,
    }));
  }
  const forumInspection = /^\/api\/v1\/thread-management\/packs\/([^/]+)\/forum\/inspect$/u.exec(pathname);
  if (forumInspection !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Forum inspection request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Forum inspection body must be an object.");
    exactFields(body, ["confirmation"], "Forum inspection body");
    if (typeof body.confirmation !== "string") throw new AdminError("invalid_request", "Forum inspection confirmation must be a string.");
    return ok(response, await service.inspectPackForum({
      packId: forumInspection[1] ?? "",
      confirmation: body.confirmation,
    }));
  }
  const canonicalProvisioningLogo = /^\/api\/v1\/thread-management\/packs\/([^/]+)\/assets\/([^/]+)\/provisioning-logo\/canonical$/u.exec(pathname);
  if (canonicalProvisioningLogo !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Canonical provisioning logo request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Canonical provisioning logo body must be an object.");
    exactFields(body, [], "Canonical provisioning logo body");
    return ok(response, await service.stageThreadProvisioningCanonicalLogo({
      packId: canonicalProvisioningLogo[1] ?? "",
      assetId: canonicalProvisioningLogo[2] ?? "",
    }), 201);
  }
  const provisioningLogo = /^\/api\/v1\/thread-management\/packs\/([^/]+)\/assets\/([^/]+)\/provisioning-logo$/u.exec(pathname);
  if (provisioningLogo !== null) {
    if (method !== "PUT") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Provisioning logo request");
    const bytes = await readAssetLogoBody(request);
    return ok(response, await service.stageThreadProvisioningLogo({
      packId: provisioningLogo[1] ?? "",
      assetId: provisioningLogo[2] ?? "",
      bytes,
    }), 201);
  }
  if (pathname === "/api/v1/thread-management/provision") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Thread provisioning request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Thread provisioning body must be an object.");
    exactFields(body, ["packId", "assetId", "title", "appliedTagIds", "logoSha256", "confirmation"], "Thread provisioning body");
    if (
      typeof body.packId !== "string" ||
      typeof body.assetId !== "string" ||
      typeof body.title !== "string" ||
      !Array.isArray(body.appliedTagIds) ||
      !body.appliedTagIds.every((tagId) => typeof tagId === "string") ||
      typeof body.logoSha256 !== "string" ||
      typeof body.confirmation !== "string"
    ) {
      throw new AdminError("invalid_request", "Thread provisioning fields have invalid types.");
    }
    return ok(response, await service.provisionNewThread({
      packId: body.packId,
      assetId: body.assetId,
      title: body.title,
      appliedTagIds: body.appliedTagIds as string[],
      logoSha256: body.logoSha256,
      confirmation: body.confirmation,
    }), 201);
  }
  if (pathname === "/api/v1/thread-management/adopt") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Thread adoption body must be an object.");
    exactFields(body, ["packId", "assetId", "threadId", "confirmation"], "Thread adoption body");
    if (
      typeof body.packId !== "string" ||
      typeof body.assetId !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.confirmation !== "string"
    ) {
      throw new AdminError("invalid_request", "Thread adoption fields must be strings.");
    }
    return ok(response, await service.adoptExistingThread({
      packId: body.packId,
      assetId: body.assetId,
      threadId: body.threadId,
      confirmation: body.confirmation,
    }));
  }
  if (pathname === "/api/v1/thread-management/binding/inspect") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Thread-binding inspection request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Thread-binding inspection body must be an object.");
    exactFields(body, ["packId", "assetId", "threadId", "confirmation"], "Thread-binding inspection body");
    if (
      typeof body.packId !== "string" ||
      typeof body.assetId !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.confirmation !== "string"
    ) throw new AdminError("invalid_request", "Thread-binding inspection fields must be strings.");
    return ok(response, await service.inspectExistingThreadBinding({
      packId: body.packId,
      assetId: body.assetId,
      threadId: body.threadId,
      confirmation: body.confirmation,
    }));
  }
  if (pathname === "/api/v1/thread-management/binding/replace") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Thread-binding replacement request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Thread-binding replacement body must be an object.");
    exactFields(body, ["packId", "assetId", "currentThreadId", "nextThreadId", "confirmation"], "Thread-binding replacement body");
    if (
      typeof body.packId !== "string" ||
      typeof body.assetId !== "string" ||
      typeof body.currentThreadId !== "string" ||
      typeof body.nextThreadId !== "string" ||
      typeof body.confirmation !== "string"
    ) throw new AdminError("invalid_request", "Thread-binding replacement fields must be strings.");
    return ok(response, await service.replaceExistingThreadBinding({
      packId: body.packId,
      assetId: body.assetId,
      currentThreadId: body.currentThreadId,
      nextThreadId: body.nextThreadId,
      confirmation: body.confirmation,
    }));
  }
  if (pathname === "/api/v1/thread-management/binding") {
    if (method !== "DELETE") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Thread-binding removal request");
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Thread-binding removal body must be an object.");
    exactFields(body, ["packId", "assetId", "currentThreadId", "confirmation"], "Thread-binding removal body");
    if (
      typeof body.packId !== "string" ||
      typeof body.assetId !== "string" ||
      typeof body.currentThreadId !== "string" ||
      typeof body.confirmation !== "string"
    ) throw new AdminError("invalid_request", "Thread-binding removal fields must be strings.");
    return ok(response, await service.removeExistingThreadBinding({
      packId: body.packId,
      assetId: body.assetId,
      currentThreadId: body.currentThreadId,
      confirmation: body.confirmation,
    }));
  }
  if (pathname === "/api/v1/standalone-render/options" && method === "GET") {
    return ok(response, service.standaloneRenderOptions());
  }
  if (pathname === "/api/v1/standalone-renders") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, ["assetId", "timeframe", "filename"], "Standalone render request");
    const bytes = await readChartRenderBody(request, "Standalone");
    return ok(response, await service.renderStandaloneChart({
      assetId: url.searchParams.get("assetId") ?? "",
      timeframe: url.searchParams.get("timeframe"),
      sourceFilename: url.searchParams.get("filename") ?? "",
      sourceBytes: bytes,
    }), 201);
  }
  const standaloneArtifact = /^\/api\/v1\/standalone-renders\/([a-f0-9]{32})\/(publication\.png|receipt\.json)$/u.exec(pathname);
  if (standaloneArtifact !== null) {
    if (method !== "GET" && method !== "HEAD") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const artifact = standaloneArtifact[2] as "publication.png" | "receipt.json";
    const bytes = await service.readStandaloneRenderArtifact(standaloneArtifact[1] ?? "", artifact);
    return binaryArtifact(request, response, bytes, artifact);
  }
  if (pathname === "/api/v1/pack-workspace") {
    if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    return ok(response, await service.packWorkspaceState());
  }
  if (pathname === "/api/v1/pack-workspace/capture-session") {
    if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, ["packId"], "Pack capture-session state request");
    return ok(response, await service.packCaptureSessionState(url.searchParams.get("packId") ?? ""));
  }
  if (pathname === "/api/v1/pack-workspace/capture-session/start") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Start capture-session body must be an object.");
    exactFields(body, ["packId"], "Start capture-session body");
    if (typeof body.packId !== "string") throw new AdminError("invalid_request", "Start capture-session packId must be a string.");
    return ok(response, await service.startPackCaptureSession(body.packId), 201);
  }
  if (pathname === "/api/v1/pack-workspace/capture-session/scan") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Scan capture-session body must be an object.");
    exactFields(body, ["packId"], "Scan capture-session body");
    if (typeof body.packId !== "string") throw new AdminError("invalid_request", "Scan capture-session packId must be a string.");
    return ok(response, await service.scanPackCaptureSession(body.packId));
  }
  const packRevisionArtifact = /^\/api\/v1\/pack-workspace\/packs\/([^/]+)\/assets\/([^/]+)\/revisions\/([1-9][0-9]*)\/(publication\.png|receipt\.json)$/u.exec(pathname);
  if (packRevisionArtifact !== null) {
    if (method !== "GET" && method !== "HEAD") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const artifact = packRevisionArtifact[4] as "publication.png" | "receipt.json";
    const bytes = await service.readPackWorkspaceRevisionArtifact(
      packRevisionArtifact[1] ?? "",
      packRevisionArtifact[2] ?? "",
      Number(packRevisionArtifact[3]),
      artifact,
    );
    return binaryArtifact(request, response, bytes, artifact);
  }
  const packRevision = /^\/api\/v1\/pack-workspace\/packs\/([^/]+)\/assets\/([^/]+)\/revisions\/([1-9][0-9]*)$/u.exec(pathname);
  if (packRevision !== null) {
    if (method !== "DELETE") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Delete Revision body must be an object.");
    exactFields(body, ["confirmation", "expectedCurrentRevision"], "Delete Revision body");
    return ok(response, await service.deletePackWorkspaceRevision({
      packId: packRevision[1] ?? "",
      assetId: packRevision[2] ?? "",
      revision: Number(packRevision[3]),
      confirmation: body.confirmation,
      expectedCurrentRevision: body.expectedCurrentRevision,
    }));
  }
  const packAssetReset = /^\/api\/v1\/pack-workspace\/packs\/([^/]+)\/assets\/([^/]+)\/reset$/u.exec(pathname);
  if (packAssetReset !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Reset Asset body must be an object.");
    exactFields(body, ["confirmation", "expectedRevisions"], "Reset Asset body");
    return ok(response, await service.resetPackWorkspaceAsset({
      packId: packAssetReset[1] ?? "",
      assetId: packAssetReset[2] ?? "",
      confirmation: body.confirmation,
      expectedRevisions: body.expectedRevisions,
    }));
  }
  const packReset = /^\/api\/v1\/pack-workspace\/packs\/([^/]+)\/reset$/u.exec(pathname);
  if (packReset !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Reset Pack body must be an object.");
    exactFields(body, ["confirmation", "expectedCapturedAssetIds"], "Reset Pack body");
    return ok(response, await service.resetPackWorkspacePack({
      packId: packReset[1] ?? "",
      confirmation: body.confirmation,
      expectedCapturedAssetIds: body.expectedCapturedAssetIds,
    }));
  }
  if (pathname === "/api/v1/pack-workspace/previews") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, ["packId", "assetId", "filename"], "Pack preview request");
    const bytes = await readChartRenderBody(request, "Pack");
    return ok(response, await service.previewPackWorkspaceChart({
      packId: url.searchParams.get("packId") ?? "",
      assetId: url.searchParams.get("assetId") ?? "",
      sourceFilename: url.searchParams.get("filename") ?? "",
      sourceBytes: bytes,
    }), 201);
  }
  const packPreviewArtifact = /^\/api\/v1\/pack-workspace\/previews\/([a-f0-9]{32})\/(publication\.png|receipt\.json)$/u.exec(pathname);
  if (packPreviewArtifact !== null) {
    if (method !== "GET" && method !== "HEAD") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const artifact = packPreviewArtifact[2] as "publication.png" | "receipt.json";
    const bytes = await service.readPackWorkspacePreviewArtifact(packPreviewArtifact[1] ?? "", artifact);
    return binaryArtifact(request, response, bytes, artifact);
  }
  const packPreviewAccept = /^\/api\/v1\/pack-workspace\/previews\/([a-f0-9]{32})\/accept$/u.exec(pathname);
  if (packPreviewAccept !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Pack preview acceptance body must be an object.");
    exactFields(body, [], "Pack preview acceptance body");
    return ok(response, await service.acceptPackWorkspacePreview(packPreviewAccept[1] ?? ""));
  }
  const packPreview = /^\/api\/v1\/pack-workspace\/previews\/([a-f0-9]{32})$/u.exec(pathname);
  if (packPreview !== null) {
    if (method !== "DELETE") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const previewId = packPreview[1] ?? "";
    await service.discardPackWorkspacePreview(previewId);
    return ok(response, {
      schemaVersion: 1,
      previewId,
      discarded: true,
      effects: Object.freeze({ workspaceChanged: false, staged: false, released: false, discordContacted: false }),
    });
  }
  if (pathname === "/api/v1/refresh" && method === "POST") return ok(response, await service.refresh());
  if (pathname === "/api/v1/assets" && method === "GET") {
    optionalSearchParameters(url, ["q", "pack", "offset", "limit"], "Asset search request");
    return ok(response, service.searchAssets({
      query: url.searchParams.get("q") ?? "",
      packId: url.searchParams.get("pack") ?? undefined,
      offset: parseInteger(url.searchParams.get("offset"), 0),
      limit: parseInteger(url.searchParams.get("limit"), 50),
    }));
  }
  const assetMatch = /^\/api\/v1\/assets\/([^/]+)$/u.exec(pathname);
  if (assetMatch !== null && method === "GET") return ok(response, service.getAsset(assetMatch[1] ?? ""));
  if (pathname === "/api/v1/registry/options" && method === "GET") {
    exactSearchParameters(url, [], "Registry options request");
    return ok(response, service.registryOptions());
  }
  if (pathname === "/api/v1/registry/csv-import/preview") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, ["filename"], "Registry CSV preview request");
    const csvText = await readRegistryCsvBody(request);
    return ok(response, service.prepareRegistryCsvImport({ fileName: url.searchParams.get("filename"), csvText }), 201);
  }
  const registryCsvApply = /^\/api\/v1\/registry\/csv-import\/([a-f0-9]{64})\/apply$/u.exec(pathname);
  if (registryCsvApply !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Registry CSV application body must be an object.");
    exactFields(body, ["confirmation"], "Registry CSV application body");
    return ok(response, await service.applyRegistryCsvImport(registryCsvApply[1] ?? "", body.confirmation));
  }
  if (pathname === "/api/v1/registry/asset-changes/preview") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Registry change preview body must be an object.");
    exactFields(body, ["change"], "Registry change preview body");
    return ok(response, await service.prepareRegistryAssetChange(body.change), 201);
  }
  const registryChangeApply = /^\/api\/v1\/registry\/asset-changes\/([^/]+)\/apply$/u.exec(pathname);
  if (registryChangeApply !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Registry change application body must be an object.");
    exactFields(body, ["confirmation"], "Registry change application body");
    return ok(response, await service.applyPreparedRegistryAssetChange(registryChangeApply[1] ?? "", body.confirmation));
  }
  const registryLogoStatus = /^\/api\/v1\/assets\/([^/]+)\/logo\/status$/u.exec(pathname);
  if (registryLogoStatus !== null) {
    if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    exactSearchParameters(url, [], "Registry logo status request");
    return ok(response, await service.inspectRegistryAssetLogo(registryLogoStatus[1] ?? ""));
  }
  const registryLogo = /^\/api\/v1\/assets\/([^/]+)\/logo$/u.exec(pathname);
  if (registryLogo !== null) {
    const assetId = registryLogo[1] ?? "";
    if (method === "GET" || method === "HEAD") {
      optionalSearchParameters(url, ["v"], "Registry logo request");
      return inlinePng(request, response, await service.readRegistryAssetLogo(assetId), `${assetId}.png`);
    }
    if (method === "PUT") {
      exactSearchParameters(url, ["expectedSha256", "confirmation"], "Registry logo upload request");
      const expected = url.searchParams.get("expectedSha256") ?? "";
      const bytes = await readAssetLogoBody(request);
      return ok(response, await service.storeRegistryAssetLogo(
        assetId,
        bytes,
        expected === "" ? null : expected,
        url.searchParams.get("confirmation"),
      ), 201);
    }
    if (method === "DELETE") {
      exactSearchParameters(url, [], "Registry logo removal request");
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Registry logo removal body must be an object.");
      exactFields(body, ["expectedSha256", "confirmation"], "Registry logo removal body");
      if (typeof body.expectedSha256 !== "string") throw new AdminError("invalid_request", "expectedSha256 must be a string.");
      return ok(response, await service.removeRegistryAssetLogo(assetId, body.expectedSha256, body.confirmation));
    }
    throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
  }
  const retirementPreview = /^\/api\/v1\/assets\/([^/]+)\/retirement-preview$/u.exec(pathname);
  if (retirementPreview !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Retirement preview body must be an object.");
    exactFields(body, [], "Retirement preview body");
    return ok(response, await service.previewRegistryAssetRetirement(retirementPreview[1] ?? ""));
  }
  const retirementApply = /^\/api\/v1\/assets\/([^/]+)\/retire$/u.exec(pathname);
  if (retirementApply !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Retirement body must be an object.");
    exactFields(body, ["previewId", "confirmation"], "Retirement body");
    return ok(response, await service.retireRegistryAsset(retirementApply[1] ?? "", body.previewId, body.confirmation));
  }
  const packAssetLogoRoute =
    /^\/api\/v1\/packs\/create\/([^/]+)\/asset-logos\/([^/]+)$/u.exec(
      pathname,
    );
  if (packAssetLogoRoute !== null) {
    if (method !== "PUT") {
      throw new AdminError(
        "method_not_allowed",
        "Method is not allowed for this route.",
        405,
      );
    }
    const bytes = await readAssetLogoBody(request);
    return ok(
      response,
      await service.stagePackBuilderAssetLogo(
        packAssetLogoRoute[1] ?? "",
        packAssetLogoRoute[2] ?? "",
        bytes,
      ),
      201,
    );
  }

  if (pathname === "/api/v1/packs/create/preview") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Create Pack preview body must be an object.");
    exactFields(body, ["input"], "Create Pack preview body");
    return ok(response, await service.previewRegistryPackCreation(body.input));
  }
  if (pathname === "/api/v1/packs/create") {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Create Pack body must be an object.");
    exactFields(body, ["packId", "previewId"], "Create Pack body");
    if (typeof body.packId !== "string") throw new AdminError("invalid_request", "packId must be a string.");
    return ok(response, await service.createPackFromPreview(body.packId, body.previewId), 201);
  }
  const packCreationState = /^\/api\/v1\/packs\/create\/([^/]+)\/state$/u.exec(pathname);
  if (packCreationState !== null) {
    if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    return ok(response, await service.packCreationState(packCreationState[1] ?? ""));
  }
  if (pathname === "/api/v1/packs" && method === "GET") return ok(response, service.listPacks());
  const packMatch = /^\/api\/v1\/packs\/([^/]+)$/u.exec(pathname);
  if (packMatch !== null && method === "GET") return ok(response, service.getPack(packMatch[1] ?? ""));

  if (pathname === "/api/v1/pack-drafts") {
    if (method === "GET") return ok(response, await service.listDrafts());
    if (method === "POST") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Draft create body must be an object.");
      exactFields(body, ["draft"], "Draft create body");
      return ok(response, await service.createDraft(body.draft), 201);
    }
    throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
  }


  const promotionProposalRoute = /^\/api\/v1\/pack-drafts\/([^/]+)\/promotion\/proposal$/u.exec(pathname);
  if (promotionProposalRoute !== null) {
    if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new AdminError("invalid_request", "Promotion proposal body must be an object.");
    exactFields(body, ["request"], "Promotion proposal body");
    return ok(response, await service.createPackPromotionProposal(promotionProposalRoute[1] ?? "", body.request), 201);
  }

  const promotionActionRoute = /^\/api\/v1\/pack-drafts\/([^/]+)\/promotion\/([a-f0-9]{64})\/(plan|source-change|review|application-authorization|apply|application-status|artifacts)(?:\/([^/]+))?$/u.exec(pathname);
  if (promotionActionRoute !== null) {
    const draftId = promotionActionRoute[1] ?? "";
    const promotionId = promotionActionRoute[2] ?? "";
    const action = promotionActionRoute[3] ?? "";
    const artifactName = promotionActionRoute[4];
    if (action === "plan") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Promotion plan body must be an object.");
      exactFields(body, ["authorization"], "Promotion plan body");
      return ok(response, await service.planPackPromotion(draftId, promotionId, body.authorization), 201);
    }
    if (action === "source-change") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Promotion source-change body must be an object.");
      exactFields(body, [], "Promotion source-change body");
      return ok(response, await service.generatePackPromotionSourceChange(draftId, promotionId), 201);
    }
    if (action === "review") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Pack source review body must be an object.");
      exactFields(body, ["decision"], "Pack source review body");
      return ok(response, await service.reviewPackPromotion(draftId, promotionId, body.decision), 201);
    }
    if (action === "application-authorization") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Pack application authorization body must be an object.");
      exactFields(body, ["authorization"], "Pack application authorization body");
      return ok(response, await service.storePackApplicationAuthorization(draftId, promotionId, body.authorization), 201);
    }
    if (action === "apply") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Pack source application body must be an object.");
      exactFields(body, ["confirmation"], "Pack source application body");
      return ok(response, await service.applyPackPromotion(draftId, promotionId, body.confirmation), 201);
    }
    if (action === "application-status") {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      return ok(response, await service.packPromotionApplicationStatus(draftId, promotionId));
    }
    if (action === "artifacts" && artifactName === undefined) {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      return ok(response, { schemaVersion: 1, promotionId, artifacts: await service.listPackPromotionArtifacts(draftId, promotionId) });
    }
    if (action === "artifacts" && artifactName !== undefined) {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      if (!PACK_PROMOTION_ARTIFACT_NAMES.includes(artifactName as PackPromotionArtifactName)) throw new AdminError("route_not_found", "Promotion artifact was not found.", 404);
      const bytes = await service.readPackPromotionArtifact(draftId, promotionId, artifactName as PackPromotionArtifactName);
      securityHeaders(response, true);
      response.statusCode = 200;
      response.setHeader("Content-Type", artifactName.endsWith(".patch") ? "text/x-diff; charset=utf-8" : "application/json; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${artifactName}"`);
      response.end(bytes);
      return;
    }
  }

  const assetRegistrationRoute = /^\/api\/v1\/asset-registrations\/([^/]+)\/(proposal|planning-authorization|plan|source-change|review|application-authorization|apply|status|artifacts)(?:\/([^/]+))?$/u.exec(pathname);
  if (assetRegistrationRoute !== null) {
    const registrationId = assetRegistrationRoute[1] ?? "";
    const action = assetRegistrationRoute[2] ?? "";
    const artifactName = assetRegistrationRoute[3];
    if (action === "proposal") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset registration proposal body must be an object.");
      exactFields(body, ["input"], "Asset registration proposal body");
      return ok(response, await service.createAssetRegistrationProposal(registrationId, body.input), 201);
    }
    if (action === "planning-authorization") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset planning authorization body must be an object.");
      exactFields(body, ["authorization"], "Asset planning authorization body");
      return ok(response, await service.storeAssetRegistrationPlanningAuthorization(registrationId, body.authorization), 201);
    }
    if (action === "plan") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset application plan body must be an object.");
      exactFields(body, [], "Asset application plan body");
      return ok(response, await service.generateAssetRegistrationPlan(registrationId), 201);
    }
    if (action === "source-change") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset source-change body must be an object.");
      exactFields(body, [], "Asset source-change body");
      return ok(response, await service.generateAssetRegistrationSourceChange(registrationId), 201);
    }
    if (action === "review") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset source review body must be an object.");
      exactFields(body, ["decision"], "Asset source review body");
      return ok(response, await service.reviewAssetRegistration(registrationId, body.decision), 201);
    }
    if (action === "application-authorization") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset application authorization body must be an object.");
      exactFields(body, ["authorization"], "Asset application authorization body");
      return ok(response, await service.storeAssetRegistrationApplicationAuthorization(registrationId, body.authorization), 201);
    }
    if (action === "apply") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Asset source application body must be an object.");
      exactFields(body, ["confirmation"], "Asset source application body");
      return ok(response, await service.applyAssetRegistration(registrationId, body.confirmation), 201);
    }
    if (action === "status") {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      return ok(response, await service.assetRegistrationStatus(registrationId));
    }
    if (action === "artifacts" && artifactName === undefined) {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      return ok(response, { schemaVersion: 1, registrationId, artifacts: await service.listAssetRegistrationArtifacts(registrationId) });
    }
    if (action === "artifacts" && artifactName !== undefined) {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      if (!ASSET_REGISTRATION_ARTIFACT_NAMES.includes(artifactName as AssetRegistrationArtifactName)) {
        throw new AdminError("route_not_found", "Asset registration artifact was not found.", 404);
      }
      const bytes = await service.readAssetRegistrationArtifact(registrationId, artifactName as AssetRegistrationArtifactName);
      securityHeaders(response, true);
      response.statusCode = 200;
      response.setHeader("Content-Type", artifactName.endsWith(".patch") ? "text/x-diff; charset=utf-8" : "application/json; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${artifactName}"`);
      response.end(bytes);
      return;
    }
  }

  const draftRoute = /^\/api\/v1\/pack-drafts\/([^/]+)(?:\/(validate|export))?$/u.exec(pathname);
  if (draftRoute !== null) {
    const draftId = draftRoute[1] ?? "";
    const action = draftRoute[2];
    if (action === "validate") {
      if (method !== "POST") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      return ok(response, await service.validateDraft(draftId));
    }
    if (action === "export") {
      if (method !== "GET") throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
      const bytes = await service.exportDraft(draftId);
      securityHeaders(response, true);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${draftId}.json"`);
      response.end(bytes);
      return;
    }
    if (method === "GET") return ok(response, await service.getDraft(draftId));
    if (method === "PUT") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Draft update body must be an object.");
      exactFields(body, ["expectedRevision", "draft"], "Draft update body");
      if (!Number.isSafeInteger(body.expectedRevision)) throw new AdminError("invalid_request", "expectedRevision must be a safe integer.");
      return ok(response, await service.updateDraft(draftId, Number(body.expectedRevision), body.draft));
    }
    if (method === "DELETE") {
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new AdminError("invalid_request", "Draft delete body must be an object.");
      exactFields(body, ["expectedRevision"], "Draft delete body");
      if (!Number.isSafeInteger(body.expectedRevision)) throw new AdminError("invalid_request", "expectedRevision must be a safe integer.");
      await service.deleteDraft(draftId, Number(body.expectedRevision));
      return ok(response, { deleted: true, draftId });
    }
    throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
  }

  throw new AdminError("route_not_found", "Route was not found.", 404);
}

export async function startAdminHttpServer(options: StartAdminHttpServerOptions): Promise<RunningAdminHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new AdminError("invalid_arguments", "Administration server host must be loopback.");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new AdminError("invalid_arguments", "Administration server port must be an integer from 0 to 65535.");
  }

  let origin = "";
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        assertSameOriginForWrite(request, origin);
        const { url, decodedPathname } = safePathname(request.url ?? "/");
        if (decodedPathname.startsWith("/api/")) {
          await routeApi(request, response, options.service, url, decodedPathname);
        } else {
          if (request.method !== "GET" && request.method !== "HEAD") {
            throw new AdminError("method_not_allowed", "Method is not allowed for this route.", 405);
          }
          await serveStatic(response, decodedPathname);
        }
      } catch (error) {
        if (!response.headersSent) errorResponse(response, error);
        else response.destroy();
      }
    })();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new AdminError("internal_error", "Administration server did not expose a TCP address.");
  }
  const displayHost = host === "::1" ? "[::1]" : host === "localhost" ? "127.0.0.1" : host;
  origin = `http://${displayHost}:${address.port}`;
  return Object.freeze({
    host,
    port: address.port,
    url: origin,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error === undefined ? resolvePromise() : reject(error));
      });
    },
  });
}
