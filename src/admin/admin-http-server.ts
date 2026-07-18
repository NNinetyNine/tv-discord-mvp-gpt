import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";

import { AdminError, PACK_DRAFT_SCHEMA_VERSION, PACK_DRAFT_TYPE } from "./admin-types.ts";
import { AdminService } from "./admin-service.ts";

export const ADMIN_REQUEST_BODY_LIMIT = 65536 as const;
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

async function serveStatic(response: ServerResponse, path: string): Promise<void> {
  const route = path === "/" ? "/index.html" : path;
  if (!new Set(["/index.html", "/styles.css", "/app.js"]).has(route)) {
    throw new AdminError("route_not_found", "Route was not found.", 404);
  }
  const assetUrl = new URL(`../admin-ui${route}`, import.meta.url);
  const bytes = await readFile(fileURLToPath(assetUrl));
  securityHeaders(response, false);
  response.statusCode = 200;
  const extension = extname(route);
  response.setHeader("Content-Type", extension === ".html" ? "text/html; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
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
  if (pathname === "/api/v1/refresh" && method === "POST") return ok(response, await service.refresh());
  if (pathname === "/api/v1/assets" && method === "GET") {
    return ok(response, service.searchAssets({
      query: url.searchParams.get("q") ?? "",
      offset: parseInteger(url.searchParams.get("offset"), 0),
      limit: parseInteger(url.searchParams.get("limit"), 50),
    }));
  }
  const assetMatch = /^\/api\/v1\/assets\/([^/]+)$/u.exec(pathname);
  if (assetMatch !== null && method === "GET") return ok(response, service.getAsset(assetMatch[1] ?? ""));
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
