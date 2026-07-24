import { describe, expect, it } from "vitest";

import { parseValidateAdminArguments, VALIDATE_ADMIN_USAGE } from "./validate-administration.ts";

describe("validate-administration CLI", () => {
  it("requires separate repository and workspace roots", () => {
    expect(() => parseValidateAdminArguments(["node", "script"])).toThrow("--repository-root and --workspace-root are required");
  });

  it("parses the read-only acceptance roots", () => {
    expect(parseValidateAdminArguments([
      "node",
      "script",
      "--repository-root",
      "/repo",
      "--workspace-root",
      "/work",
      "--chart-downloads-root",
      "/downloads",
    ])).toEqual({ repositoryRoot: "/repo", workspaceRoot: "/work", chartDownloadsRoot: "/downloads" });
  });

  it("rejects unknown, duplicate, positional, and missing arguments", () => {
    expect(() => parseValidateAdminArguments(["node", "script", "/repo"])).toThrow("Positional arguments");
    expect(() => parseValidateAdminArguments(["node", "script", "--unknown", "x"])).toThrow("Unknown argument");
    expect(() => parseValidateAdminArguments(["node", "script", "--repository-root", "/a", "--repository-root", "/b", "--workspace-root", "/w"])).toThrow("Duplicate argument");
    expect(() => parseValidateAdminArguments(["node", "script", "--repository-root", "/repo", "--workspace-root"])).toThrow("Missing value");
  });

  it("documents the exact operator command", () => {
    expect(VALIDATE_ADMIN_USAGE).toContain("--repository-root");
    expect(VALIDATE_ADMIN_USAGE).toContain("--workspace-root");
    expect(VALIDATE_ADMIN_USAGE).toContain("--chart-downloads-root");
  });
});
