import { resolve } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

/**
 * Day 3: persistent Playwright session for TradingView.
 *
 * launchPersistentContext writes cookies/localStorage to a user-data dir on
 * disk, so a one-time manual login (scripts/login.ts) is reused by every later
 * run with no re-auth. This file owns browser lifecycle ONLY — no TradingView
 * knowledge, no screenshotting. Day 4's capturer will build on top of it.
 */

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

export interface BrowserSession {
  readonly context: BrowserContext;
  /** Returns the first existing page, or opens one. */
  page(): Promise<Page>;
  /** Closes the context, flushing the session to disk. */
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Override headless; defaults to env HEADLESS (false for Day 3 so you can watch). */
  readonly headless?: boolean;
}

export async function launchSession(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const userDataDir = resolve(process.cwd(), process.env.PW_USER_DATA_DIR ?? "./.pw-profile");
  const headless = opts.headless ?? (process.env.HEADLESS ?? "false") === "true";

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { ...DEFAULT_VIEWPORT },
    // Mild anti-automation-detection: drop the navigator.webdriver flag.
    args: ["--disable-blink-features=AutomationControlled"],
  });

  return {
    context,
    async page(): Promise<Page> {
      const existing = context.pages()[0];
      return existing ?? (await context.newPage());
    },
    async close(): Promise<void> {
      await context.close();
    },
  };
}