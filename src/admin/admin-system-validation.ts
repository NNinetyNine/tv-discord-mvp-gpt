import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AdminService } from "./admin-service.ts";
import { ADMIN_CSP, startAdminHttpServer } from "./admin-http-server.ts";

export const ADMIN_ACCEPTANCE_WORKSPACES = Object.freeze([
  "workspace",
  "threads",
  "server",
  "packs",
  "archive",
  "renderer",
  "registry",
] as const);

export const ADMIN_ACCEPTANCE_CANONICAL_FILES = Object.freeze([
  "definitions/registry.json",
  "definitions/packs.json",
  "config/channels.json",
  "config/asset-threads.json",
] as const);

type AdminAcceptanceWorkspace = typeof ADMIN_ACCEPTANCE_WORKSPACES[number];

type AdminAcceptanceCheckOutcome = "passed" | "failed";

export interface AdminAcceptanceCheck {
  readonly id: string;
  readonly workspace: AdminAcceptanceWorkspace | "shell" | "security" | "custody";
  readonly outcome: AdminAcceptanceCheckOutcome;
  readonly detail: string;
}

export interface AdminSystemValidationReport {
  readonly schemaVersion: 1;
  readonly service: "visionx.admin";
  readonly outcome: AdminAcceptanceCheckOutcome;
  readonly server: {
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly loopbackOnly: true;
  };
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly workspaceCount: 7;
  };
  readonly canonicalSources: readonly {
    readonly path: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly unchanged: boolean;
  }[];
  readonly checks: readonly AdminAcceptanceCheck[];
  readonly nonEffects: {
    readonly canonicalSourcesChanged: boolean;
    readonly discordContacted: false;
    readonly writeRoutesExercised: false;
    readonly cleanupPerformed: false;
  };
}

export interface RunAdminSystemValidationOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly chartDownloadsRoot?: string;
}

interface JsonEnvelope {
  readonly ok: true;
  readonly data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function canonicalHashes(repositoryRoot: string): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  for (const relativePath of ADMIN_ACCEPTANCE_CANONICAL_FILES) {
    result.set(relativePath, sha256(await readFile(join(repositoryRoot, relativePath))));
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function jsonData(baseUrl: string, path: string): Promise<{ readonly response: Response; readonly data: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error(`${path} did not return JSON.`);
  }
  const value = await response.json() as unknown;
  if (!isRecord(value) || value.ok !== true || !("data" in value)) {
    throw new Error(`${path} did not return the VisionX success envelope.`);
  }
  return { response, data: (value as unknown as JsonEnvelope).data };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object.`);
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array.`);
  return value;
}

export async function runAdminSystemValidation(
  options: RunAdminSystemValidationOptions,
): Promise<AdminSystemValidationReport> {
  const before = await canonicalHashes(options.repositoryRoot);
  const checks: AdminAcceptanceCheck[] = [];
  const record = async (
    id: string,
    workspace: AdminAcceptanceCheck["workspace"],
    operation: () => Promise<string>,
  ): Promise<void> => {
    try {
      checks.push(Object.freeze({ id, workspace, outcome: "passed", detail: await operation() }));
    } catch (error) {
      checks.push(Object.freeze({ id, workspace, outcome: "failed", detail: errorText(error) }));
    }
  };

  const service = await AdminService.create({
    repositoryRoot: options.repositoryRoot,
    workspaceRoot: options.workspaceRoot,
    ...(options.chartDownloadsRoot === undefined ? {} : { chartDownloadsRoot: options.chartDownloadsRoot }),
  });
  const server = await startAdminHttpServer({ service, host: "127.0.0.1", port: 0 });

  try {
    await record("shell.static-entrypoints", "shell", async () => {
      const [htmlResponse, cssResponse, jsResponse] = await Promise.all([
        fetch(`${server.url}/`),
        fetch(`${server.url}/styles.css`),
        fetch(`${server.url}/app.js`),
      ]);
      for (const [label, response] of [["HTML", htmlResponse], ["CSS", cssResponse], ["JavaScript", jsResponse]] as const) {
        if (response.status !== 200) throw new Error(`${label} returned HTTP ${response.status}.`);
        if (response.headers.get("cache-control") !== "no-cache") throw new Error(`${label} did not use no-cache custody.`);
      }
      const [html, css, js] = await Promise.all([htmlResponse.text(), cssResponse.text(), jsResponse.text()]);
      for (const workspace of ADMIN_ACCEPTANCE_WORKSPACES) {
        if (!html.includes(`id="nav-${workspace}"`) || !html.includes(`data-view-panel="${workspace}"`)) {
          throw new Error(`The ${workspace} workspace is missing from the shell.`);
        }
      }
      if (!html.includes('href="/styles.css"') || !html.includes('src="/app.js"')) {
        throw new Error("The shell no longer uses the first-party static entrypoints.");
      }
      if (/https?:\/\//u.test(html) || /@import\s|url\(["']?https?:/u.test(css)) {
        throw new Error("The shell introduced an external presentation dependency.");
      }
      if (!js.includes("function activateView(view, options = {})")) {
        throw new Error("The workspace activation contract is missing.");
      }
      return `${ADMIN_ACCEPTANCE_WORKSPACES.length} workspaces and all local static entrypoints loaded.`;
    });

    await record("security.loopback-and-headers", "security", async () => {
      if (server.host !== "127.0.0.1") throw new Error("Administration did not bind to loopback.");
      const [html, api] = await Promise.all([fetch(`${server.url}/`), fetch(`${server.url}/api/v1/status`)]);
      for (const response of [html, api]) {
        if (response.headers.get("content-security-policy") !== ADMIN_CSP) throw new Error("Content Security Policy changed.");
        if (response.headers.get("x-content-type-options") !== "nosniff") throw new Error("nosniff is missing.");
        if (response.headers.get("x-frame-options") !== "DENY") throw new Error("Frame denial is missing.");
        if (response.headers.get("referrer-policy") !== "no-referrer") throw new Error("Referrer policy changed.");
      }
      if (api.headers.get("cache-control") !== "no-store") throw new Error("API responses are not no-store.");
      return "Loopback binding and the complete security-header contract are intact.";
    });

    await record("workspace.read-model", "workspace", async () => {
      const [{ data: statusValue }, { data: channelsValue }, { data: workspaceValue }] = await Promise.all([
        jsonData(server.url, "/api/v1/status"),
        jsonData(server.url, "/api/v1/channels"),
        jsonData(server.url, "/api/v1/pack-workspace"),
      ]);
      const status = requireRecord(statusValue, "Status");
      const channels = requireRecord(channelsValue, "Channels");
      const workspace = requireRecord(workspaceValue, "Workspace");
      if (status.sourceIntegrity !== "verified") throw new Error("Canonical source integrity is not verified.");
      const packCount = Number(status.packCount);
      if (!Number.isInteger(packCount) || packCount < 1) throw new Error("Status reported no Packs.");
      if (requireArray(channels.logicalChannels, "Logical channels").length < 1) throw new Error("No logical channels were available.");
      if (requireArray(workspace.packs, "Workspace Packs").length !== packCount) throw new Error("Workspace Pack count diverged from status.");
      return `${packCount} Pack workspaces loaded against verified canonical state.`;
    });

    await record("threads.read-model", "threads", async () => {
      const { data } = await jsonData(server.url, "/api/v1/thread-management");
      const state = requireRecord(data, "Thread management");
      const packs = requireArray(state.packs, "Thread-management Packs");
      if (state.publicationAvailable !== false) throw new Error("Thread management gained publication authority.");
      return `${packs.length} Pack routing projections loaded without Discord contact.`;
    });

    await record("server.read-model", "server", async () => {
      const [{ data: configurationValue }, { data: toolsValue }] = await Promise.all([
        jsonData(server.url, "/api/v1/server-configuration"),
        jsonData(server.url, "/api/v1/operator-tools"),
      ]);
      const configuration = requireRecord(configurationValue, "Server configuration");
      const tools = requireRecord(toolsValue, "Operator tools");
      const credential = requireRecord(configuration.credential, "Credential status");
      if (credential.valueExposed !== false || credential.editable !== false) throw new Error("Credential secrecy changed.");
      if (configuration.connectionTestAvailable !== false) throw new Error("Token-free validation unexpectedly enabled live Discord contact.");
      if (!isRecord(tools.marketIdentityAudit) || !isRecord(tools.archive)) throw new Error("Operator audit projections are incomplete.");
      return "Server configuration, credential secrecy, and operator audits loaded in safe offline mode.";
    });

    await record("packs.read-model", "packs", async () => {
      const { data } = await jsonData(server.url, "/api/v1/packs/maintenance");
      const state = requireRecord(data, "Pack maintenance");
      const packs = requireArray(state.packs, "Maintained Packs");
      if (typeof state.packsSourceSha256 !== "string") throw new Error("Pack source custody hash is missing.");
      return `${packs.length} current Packs loaded with exact source custody.`;
    });

    await record("archive.read-model", "archive", async () => {
      const { data } = await jsonData(server.url, "/api/v1/releases");
      const state = requireRecord(data, "Release archive");
      const releases = requireArray(state.releases, "Releases");
      if (Number(state.releaseCount) !== releases.length) throw new Error("Release archive count is inconsistent.");
      return `${releases.length} historical Releases loaded through the read-only archive projection.`;
    });

    await record("renderer.read-model", "renderer", async () => {
      const { data } = await jsonData(server.url, "/api/v1/standalone-render/options");
      const state = requireRecord(data, "Render options");
      const assets = requireArray(state.assets, "Renderer Assets");
      const timeframes = requireArray(state.timeframes, "Renderer timeframes");
      if (assets.length < 1 || timeframes.length < 1) throw new Error("Renderer options are incomplete.");
      return `${assets.length} Registry Assets and ${timeframes.length} timeframes remained discoverable.`;
    });

    await record("registry.read-model", "registry", async () => {
      const [{ data: optionsValue }, { data: searchValue }] = await Promise.all([
        jsonData(server.url, "/api/v1/registry/options"),
        jsonData(server.url, "/api/v1/assets?offset=0&limit=1"),
      ]);
      const optionsState = requireRecord(optionsValue, "Registry options");
      const searchState = requireRecord(searchValue, "Registry search");
      if (requireArray(optionsState.logicalChannels, "Registry logical channels").length < 1) throw new Error("Registry channels are missing.");
      if (requireArray(searchState.assets, "Registry Assets").length !== 1) throw new Error("Bounded Registry search did not return one Asset.");
      return `${String(searchState.total)} Registry Assets are searchable through the canonical contract.`;
    });
  } finally {
    await server.close();
  }

  const after = await canonicalHashes(options.repositoryRoot);
  const canonicalSources = ADMIN_ACCEPTANCE_CANONICAL_FILES.map((path) => {
    const beforeSha256 = before.get(path) ?? "";
    const afterSha256 = after.get(path) ?? "";
    return Object.freeze({ path, beforeSha256, afterSha256, unchanged: beforeSha256 === afterSha256 });
  });
  const canonicalSourcesChanged = canonicalSources.some((source) => !source.unchanged);
  checks.push(Object.freeze({
    id: "custody.canonical-sources-unchanged",
    workspace: "custody",
    outcome: canonicalSourcesChanged ? "failed" : "passed",
    detail: canonicalSourcesChanged
      ? "One or more canonical source files changed during read-only validation."
      : "Registry, Packs, channels, and thread bindings retained exact bytes.",
  }));

  const failed = checks.filter((check) => check.outcome === "failed").length;
  const passed = checks.length - failed;
  return Object.freeze({
    schemaVersion: 1,
    service: "visionx.admin",
    outcome: failed === 0 ? "passed" : "failed",
    server: Object.freeze({ host: "127.0.0.1", port: server.port, loopbackOnly: true }),
    summary: Object.freeze({ passed, failed, workspaceCount: 7 }),
    canonicalSources: Object.freeze(canonicalSources),
    checks: Object.freeze(checks),
    nonEffects: Object.freeze({
      canonicalSourcesChanged,
      discordContacted: false,
      writeRoutesExercised: false,
      cleanupPerformed: false,
    }),
  });
}
