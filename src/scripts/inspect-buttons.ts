import { launchSession } from "../capture/browser.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logger.ts";

/**
 * Diagnostic: dump TradingView's buttons so you can find the fullscreen /
 * chart-only control on YOUR build. Loads the first ticker's chart headed,
 * settles, then lists every labeled button with its aria-label / title /
 * data-tooltip / data-name / text. Keyword matches (fullscreen, maximize,
 * panel, hide, expand...) are printed first.
 *
 * Use the printed attributes to update the candidate list in capture/index.ts.
 */
const KEYWORDS = /fullscreen|maximi|panel|hide|chart only|expand|collapse/i;

async function main(): Promise<void> {
  const config = loadConfig();
  const ticker = config.tickers[0];
  if (!ticker) {
    logger.fatal("no tickers configured");
    process.exitCode = 1;
    return;
  }

  const session = await launchSession({ headless: false });
  try {
    const page = await session.page();
    await page.goto(ticker.tvLayoutUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("canvas", { timeout: 60_000 });
    await page.waitForTimeout(5_000);

    const buttons = page.locator('button, [role="button"]');
    const n = await buttons.count();
    logger.info({ totalButtons: n }, "scanning candidate buttons");

    const matches: string[] = [];
    const all: string[] = [];

    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const aria = await b.getAttribute("aria-label").catch(() => null);
      const title = await b.getAttribute("title").catch(() => null);
      const tooltip = await b.getAttribute("data-tooltip").catch(() => null);
      const dataName = await b.getAttribute("data-name").catch(() => null);
      let text = "";
      try {
        text = (await b.innerText({ timeout: 500 })).trim().slice(0, 40);
      } catch {
        text = "";
      }

      const label = [aria, title, tooltip, dataName, text].filter(Boolean).join(" | ");
      if (!label) continue;

      const row = JSON.stringify({ i, aria, title, tooltip, dataName, text });
      all.push(row);
      if (KEYWORDS.test(label)) matches.push(row);
    }

    console.log("\n=== KEYWORD MATCHES (fullscreen / maximize / panel / hide / expand) ===");
    if (matches.length === 0) console.log("(none — scan the full list below)");
    for (const m of matches) console.log(m);

    console.log("\n=== ALL LABELED BUTTONS ===");
    for (const a of all) console.log(a);

    logger.info({ matches: matches.length, labeled: all.length }, "scan complete");
  } finally {
    await session.close();
  }
}

main().catch((e: unknown) => {
  logger.fatal({ error: e instanceof Error ? e.message : String(e) }, "inspect-buttons failed");
  process.exitCode = 1;
});