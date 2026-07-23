import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AdminError } from "../admin/admin-types.ts";
import { AdminService } from "../admin/admin-service.ts";
import { startAdminHttpServer } from "../admin/admin-http-server.ts";
import { openDiscordForumSession } from "../publish/discord-forum-session.ts";
import { openPublisherSession } from "../publish/discord-session.ts";

export const START_ADMIN_USAGE = "Usage: npx tsx src/scripts/start-admin.ts --repository-root <path> --workspace-root <path> [--chart-downloads-root <path>] [--host 127.0.0.1] [--port 4173]";

export interface StartAdminArguments {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly chartDownloadsRoot?: string;
  readonly host: string;
  readonly port: number;
}

export function parseStartAdminArguments(argv: readonly string[]): StartAdminArguments {
  const values = new Map<string, string>();
  const allowed = new Set(["--repository-root", "--workspace-root", "--chart-downloads-root", "--host", "--port"]);
  const supplied = argv.slice(2);
  for (let index = 0; index < supplied.length; index += 2) {
    const flag = supplied[index];
    const value = supplied[index + 1];
    if (flag === undefined || !flag.startsWith("--")) throw new AdminError("invalid_arguments", "Positional arguments are not accepted.");
    if (!allowed.has(flag)) throw new AdminError("invalid_arguments", `Unknown argument: ${flag}.`);
    if (values.has(flag)) throw new AdminError("invalid_arguments", `Duplicate argument: ${flag}.`);
    if (value === undefined || value.startsWith("--")) throw new AdminError("invalid_arguments", `Missing value for ${flag}.`);
    values.set(flag, value);
  }
  const repositoryRoot = values.get("--repository-root");
  const workspaceRoot = values.get("--workspace-root");
  if (repositoryRoot === undefined || workspaceRoot === undefined) {
    throw new AdminError("invalid_arguments", "--repository-root and --workspace-root are required.");
  }
  const host = values.get("--host") ?? "127.0.0.1";
  const chartDownloadsRoot = values.get("--chart-downloads-root");
  const portText = values.get("--port") ?? "4173";
  if (!/^[0-9]+$/u.test(portText)) throw new AdminError("invalid_arguments", "--port must be an integer from 0 to 65535.");
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new AdminError("invalid_arguments", "--port must be an integer from 0 to 65535.");
  return Object.freeze({
    repositoryRoot,
    workspaceRoot,
    ...(chartDownloadsRoot === undefined ? {} : { chartDownloadsRoot }),
    host,
    port,
  });
}

export async function main(
  argv: readonly string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): Promise<number> {
  try {
    const options = parseStartAdminArguments(argv);
    const discordConfigured = (process.env.DISCORD_BOT_TOKEN?.trim().length ?? 0) > 0;
    const service = await AdminService.create({
      repositoryRoot: options.repositoryRoot,
      workspaceRoot: options.workspaceRoot,
      ...(options.chartDownloadsRoot === undefined ? {} : {
        chartDownloadsRoot: options.chartDownloadsRoot,
      }),
      ...(discordConfigured ? {
        openDiscordForumSession,
        openDiscordForumProvisioningSession: openDiscordForumSession,
        openPublisherSession,
      } : {}),
    });
    const server = await startAdminHttpServer({ service, host: options.host, port: options.port });
    stdout(JSON.stringify({
      ok: true,
      service: "visionx.admin",
      url: server.url,
      host: server.host,
      port: server.port,
      canonicalState: "controlled_write",
      canonicalStateReadOnly: false,
      workspaceType: "pack-builder",
    }, null, 2));

    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return 0;
  } catch (error) {
    const adminError = error instanceof AdminError ? error : new AdminError("internal_error", "Administration server failed to start.");
    stderr(JSON.stringify({ ok: false, error: { code: adminError.code, message: adminError.message } }, null, 2));
    if (adminError.code === "invalid_arguments") stderr(START_ADMIN_USAGE);
    return adminError.code === "invalid_arguments" ? 2 : 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}
