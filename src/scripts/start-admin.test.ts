import { describe, expect, it } from "vitest";
import { parseStartAdminArguments, START_ADMIN_USAGE } from "./start-admin.ts";

describe("start-admin CLI", () => {
  it("requires explicit repository and workspace roots", () => {
    expect(() => parseStartAdminArguments(["node", "script"])).toThrowError(expect.objectContaining({ code: "invalid_arguments" }));
  });

  it("parses mandatory paths and defaults", () => {
    expect(parseStartAdminArguments(["node", "script", "--repository-root", "/repo", "--workspace-root", "/work"])).toEqual({ repositoryRoot: "/repo", workspaceRoot: "/work", host: "127.0.0.1", port: 4173 });
  });

  it("accepts port zero", () => {
    expect(parseStartAdminArguments(["node", "script", "--repository-root", "/repo", "--workspace-root", "/work", "--port", "0"]).port).toBe(0);
  });

  it("accepts one explicit Chart Downloads folder", () => {
    expect(parseStartAdminArguments([
      "node",
      "script",
      "--repository-root",
      "/repo",
      "--workspace-root",
      "/work",
      "--chart-downloads-root",
      "/Users/operator/Downloads/TradingView",
    ])).toMatchObject({
      chartDownloadsRoot: "/Users/operator/Downloads/TradingView",
    });
  });

  it("rejects positional arguments", () => {
    expect(() => parseStartAdminArguments(["node", "script", "/repo"])).toThrowError(expect.objectContaining({ code: "invalid_arguments" }));
  });

  it("rejects unknown flags", () => {
    expect(() => parseStartAdminArguments(["node", "script", "--repository-root", "/repo", "--workspace-root", "/work", "--unknown", "x"])).toThrowError(expect.objectContaining({ code: "invalid_arguments" }));
  });

  it("rejects duplicate flags", () => {
    expect(() => parseStartAdminArguments(["node", "script", "--repository-root", "/repo", "--repository-root", "/repo2", "--workspace-root", "/work"])).toThrowError(expect.objectContaining({ code: "invalid_arguments" }));
  });

  it("rejects missing values", () => {
    expect(() => parseStartAdminArguments(["node", "script", "--repository-root", "/repo", "--workspace-root"])).toThrowError(expect.objectContaining({ code: "invalid_arguments" }));
  });

  it("publishes concise usage text", () => {
    expect(START_ADMIN_USAGE).toContain("--repository-root");
    expect(START_ADMIN_USAGE).toContain("--workspace-root");
    expect(START_ADMIN_USAGE).toContain("--chart-downloads-root");
  });
});
