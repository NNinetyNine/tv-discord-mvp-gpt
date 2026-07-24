import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const ADMIN_CANONICAL_FIXTURE_ROOT = resolve("fixtures/admin-canonical");

export async function copyAdminCanonicalFixture(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(resolve(ADMIN_CANONICAL_FIXTURE_ROOT, "definitions"), resolve(destination, "definitions"), { recursive: true }),
    cp(resolve(ADMIN_CANONICAL_FIXTURE_ROOT, "config"), resolve(destination, "config"), { recursive: true }),
    cp(resolve(ADMIN_CANONICAL_FIXTURE_ROOT, "assets"), resolve(destination, "assets"), { recursive: true }),
  ]);
}
