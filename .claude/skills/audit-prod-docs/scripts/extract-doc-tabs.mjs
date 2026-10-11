#!/usr/bin/env node
// Extract the text of every tab in the Cycloid prod docs Google Doc.
//
// The prod docs page (https://docs.trycycloid.com/) is a static HTML shell
// that full-viewport-embeds a public Google Doc via an <iframe> pointing at
// `/preview`. The Doc uses Google Docs' native "tabs" feature.
//
// Google Docs renders body text to a <canvas>, so scraping innerText yields
// only tab titles. Instead we use Playwright ONLY to enumerate the tabs and
// their stable `t.<id>` ids, then pull each tab's clean plain text from the
// public export endpoint:
//   https://docs.google.com/document/d/<DOC_ID>/export?format=txt&tab=t.<id>
//
// Output: <outdir>/manifest.json + one <NN>-<slug>.txt per tab.
//
// Usage:
//   node extract-doc-tabs.mjs [--url <docsUrl>] [--out <dir>]
// Defaults: --url https://docs.trycycloid.com/  --out ./prod-docs-tabs
//
// Requires the repo's `playwright` package + a chromium build:
//   npx playwright install chromium

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DOCS_URL = arg("--url", "https://docs.trycycloid.com/");
const OUT = resolve(arg("--out", "./prod-docs-tabs"));

// Lines that are Google Docs chrome or author scaffolding, not real content.
const NOISE = [
  /^Turn on screen reader support$/i,
  /^To enable screen reader support/i,
  /^To learn about keyboard shortcuts/i,
  /click the bubble to see all tabs/i,
];

function clean(text) {
  return text
    .replace(/^﻿/, "") // strip BOM
    .split("\n")
    .map((l) => l.replace(/ /g, " ").trimEnd())
    .filter((l) => !NOISE.some((re) => re.test(l.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "tab";

async function exportTab(docId, tabId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt&tab=${tabId}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`export ${tabId} -> HTTP ${res.status}`);
  return clean(await res.text());
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  await page.goto(DOCS_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3500);

  const frame = page.frames().find((f) => f.url().includes("docs.google.com"));
  if (!frame) throw new Error("No Google Docs iframe found on " + DOCS_URL);

  const docId = (frame.url().match(/\/document\/d\/([^/]+)/) || [])[1];
  if (!docId) throw new Error("Could not parse Google Doc id from " + frame.url());

  const openMenu = async () => {
    await frame.getByRole("button", { name: /Show tabs/i }).click({ timeout: 15000 });
    await page.waitForTimeout(900);
  };

  // Google renders each tab as a role=menuitem whose aria-label ends with
  // ", level <n>, <i> of <total>". Enumerate them.
  await openMenu();
  const labels = await frame.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')]
      .map((el) => el.getAttribute("aria-label") || "")
      .filter((l) => /,\s*level\s*\d+,\s*\d+\s*of\s*\d+\s*$/i.test(l)),
  );
  if (!labels.length) throw new Error("No tab menuitems found; Google Docs UI may have changed.");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  const names = labels.map((l) => l.replace(/,\s*level\s*\d+,\s*\d+\s*of\s*\d+\s*$/i, "").trim());
  const levels = labels.map((l) => Number((l.match(/level\s*(\d+)/i) || [])[1] || 1));
  console.error(`Doc ${docId} - found ${names.length} tabs: ${names.join(" | ")}`);

  const manifest = [];
  for (let i = 0; i < labels.length; i++) {
    // Click the tab to reveal its stable ?tab=t.<id> in the frame URL.
    await openMenu();
    await frame.getByRole("menuitem", { name: labels[i] }).click({ timeout: 15000 });
    await page.waitForTimeout(1400);
    const tabId = (frame.url().match(/[?&]tab=([^&#]+)/) || [])[1];
    if (!tabId) {
      console.error(`  [${i + 1}] ${names[i]}: could not resolve tab id, skipping`);
      continue;
    }

    const text = await exportTab(docId, tabId);
    const file = `${String(i + 1).padStart(2, "0")}-${slug(names[i])}.txt`;
    const header =
      `# ${names[i]}\n` +
      `# tab: ${tabId}  level: ${levels[i]}\n` +
      `# deep-link: https://docs.trycycloid.com/?tab=${tabId}\n\n`;
    writeFileSync(resolve(OUT, file), header + text + "\n");
    manifest.push({
      index: i + 1,
      name: names[i],
      level: levels[i],
      tabId,
      deepLink: `https://docs.trycycloid.com/?tab=${tabId}`,
      textFile: file,
      chars: text.length,
    });
    console.error(`  [${i + 1}/${labels.length}] ${names[i]} (${text.length} chars) -> ${file}`);
  }

  writeFileSync(
    resolve(OUT, "manifest.json"),
    JSON.stringify({ docsUrl: DOCS_URL, docId, tabs: manifest }, null, 2) + "\n",
  );
  await browser.close();
  console.error(`\nDone. ${manifest.length} tabs written to ${OUT}`);
  console.log(OUT);
}

main().catch((e) => {
  console.error("EXTRACTION FAILED:", e.message);
  if (/Executable doesn.t exist|playwright install/i.test(e.message)) {
    console.error("\nRun: npx playwright install chromium");
  }
  process.exit(1);
});
