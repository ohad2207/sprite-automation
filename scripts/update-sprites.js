// scripts/update-sprites.js
//
// Scrapes https://fortnite.gg/sprites TWICE — once per season filter ("C7 S4"
// and "C7 S3", confirmed real filter labels on the live page) — and writes
// two separate files, each already shaped like one season's sprites.json in
// the Fortnite Sprite Tracker app:
//
//   data/season-current.json   <- "C7 S4" (the active/current season)
//   data/season-previous.json  <- "C7 S3" (the prior season)
//
// IMPORTANT: season separation relies ONLY on actually clicking the site's
// own season filter control (selectSeasonFilter, matched by visible text —
// not by a guessed CSS class) and then extracting whatever the filtered page
// shows. An earlier version of this file also tried to double-check each
// item's season by walking up to a guessed container class and pattern-
// matching its text, falling back to a getBoundingClientRect() visibility
// check. That heuristic caused two real bugs: (1) missing images, because
// elements can legitimately report a zero-size bounding rect for a moment
// while still loading, getting them wrongly skipped as "wrong season", and
// (2) sprites appearing in both season files inconsistently, because the
// heuristic's season guess didn't reliably agree with the real filter state
// between the two scrape passes. Don't reintroduce that kind of per-item
// guessing — trust the site's own filter click and nothing else.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'data');
const SPRITES_URL = 'https://fortnite.gg/sprites';

const SEASONS = [
  { filterLabel: 'C7 S4', outFile: 'season-current.json', seasonName: 'Chapter 7 Season 4' },
  { filterLabel: 'C7 S3', outFile: 'season-previous.json', seasonName: 'Chapter 7 Season 3' },
];

// Longest-first so e.g. "trick-or-treat" is checked before any shorter
// token that might accidentally be a substring of it.
const VARIANT_TOKENS = [
  { slugToken: 'trick-or-treat', id: 'tricktreat', label: 'Trick or Treat' },
  { slugToken: 'bounty-hunter', id: 'bountyhunter', label: 'Bounty Hunter' },
  { slugToken: 'loot-hacker', id: 'hacker', label: 'Loot Hacker' },
  { slugToken: 'cheat-master', id: 'cheatmaster', label: 'Cheat Master' },
  { slugToken: 'holofoil', id: 'holofoil', label: 'Holofoil' },
  { slugToken: 'galaxy', id: 'galaxy', label: 'Galaxy' },
  { slugToken: 'gummy', id: 'gummy', label: 'Gummy' },
  { slugToken: 'quack', id: 'quack', label: 'Quack' },
  { slugToken: 'cube', id: 'cube', label: 'Cube' },
  { slugToken: 'gem', id: 'gem', label: 'Gem' },
  { slugToken: 'gold', id: 'gold', label: 'Gold' },
];

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseSlug(slug) {
  for (const variant of VARIANT_TOKENS) {
    if (slug.startsWith(variant.slugToken + '-')) {
      return { variant, baseSlug: slug.slice(variant.slugToken.length + 1) };
    }
  }
  return { variant: null, baseSlug: slug };
}

// Generous timing on purpose: this is what reliably gets images loaded.
// A previous attempt shortened these (500ms/100ms) to save CI time and it
// left roughly half the images unresolved. Don't shorten this again without
// checking the output image count stays complete.
async function forceLoadAllImages(page) {
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    document.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (lazySrc && !img.src) img.src = lazySrc;
    });
  });
  await page.evaluate(async () => {
    const step = window.innerHeight;
    const scrollHeight = document.body.scrollHeight;
    for (let y = 0; y < scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

// Clicks the season filter control that exactly matches `label` (e.g. "C7 S4").
// Text-match locator, not a guessed CSS selector — more resilient to a
// layout change, and this is the SINGLE source of truth for which season
// is active. Nothing downstream should second-guess it.
async function selectSeasonFilter(page, label) {
  const locator = page.getByText(label, { exact: true });
  await locator.first().click();
  await page.waitForTimeout(1500); // let the filtered list actually re-render
}

async function extractEntries(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/sprites/"]'));
    const bySlug = {};

    for (const a of anchors) {
      const match = a.getAttribute('href').match(/\/sprites\/(\d+)-([a-z0-9-]+)-sprite/i);
      if (!match) continue;
      const [, numericId, slug] = match;

      if (!bySlug[numericId]) {
        bySlug[numericId] = { numericId, slug: slug.toLowerCase(), name: '', image: '', released: true };
      }
      const entry = bySlug[numericId];

      const img = a.querySelector('img');
      if (img) {
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        if (src && src.includes('/sprites/icons/')) entry.image = src;
      }

      const text = a.textContent.trim();
      if (text && !entry.name) entry.name = text;

      const container = a.closest('div, li, article') || a.parentElement;
      if (container && /Unreleased/i.test(container.textContent)) {
        entry.released = false;
      }
    }

    return Object.values(bySlug);
  });
}

function buildCategories(rawEntries) {
  const categories = {};
  const order = [];

  for (const entry of rawEntries) {
    const { variant, baseSlug } = parseSlug(entry.slug);

    if (!categories[baseSlug]) {
      categories[baseSlug] = { id: slugify(baseSlug), baseName: null, baseImage: '', items: [] };
      order.push(baseSlug);
    }
    const cat = categories[baseSlug];

    if (!variant) {
      cat.baseName = entry.name;
      cat.baseImage = entry.image || cat.baseImage;
    }

    cat.items.push({
      itemId: `${slugify(baseSlug)}_${variant ? variant.id : 'normal'}`,
      isBase: !variant,
      variantLabel: variant ? variant.label : null,
      image: entry.image || '',
      released: entry.released,
    });
  }

  return order.map((baseSlug) => {
    const cat = categories[baseSlug];
    const catName =
      cat.baseName ||
      baseSlug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const items = cat.items
      .map((it) => ({
        id: it.itemId,
        name: it.isBase ? catName : `${catName} ${it.variantLabel}`,
        image: it.image,
        released: it.released,
      }))
      .sort((a, b) => (a.id.endsWith('_normal') ? -1 : b.id.endsWith('_normal') ? 1 : 0));

    return { id: cat.id, name: catName, image: cat.baseImage, items };
  });
}

// A fresh page per season (full reload + fresh filter click) rather than
// reusing one page and re-clicking a different filter on it — this avoids
// any stale-state carrying over between the two scrapes.
async function scrapeSeason(browser, season) {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  try {
    console.log(`Opening ${SPRITES_URL} for ${season.seasonName}...`);
    await page.goto(SPRITES_URL, { waitUntil: 'networkidle', timeout: 60000 });

    await selectSeasonFilter(page, season.filterLabel);
    await forceLoadAllImages(page);

    const rawEntries = await extractEntries(page);
    console.log(`  -> ${rawEntries.length} entries for ${season.seasonName}`);
    return rawEntries;
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const season of SEASONS) {
    const rawEntries = await scrapeSeason(browser, season);

    if (rawEntries.length === 0) {
      console.error(`No entries found for "${season.seasonName}" — skipping this file so it isn't overwritten with empty data.`);
      continue;
    }

    const categories = buildCategories(rawEntries);
    const output = {
      version: 'auto-' + new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
      season: season.seasonName,
      categories,
    };

    const outPath = path.join(OUT_DIR, season.outFile);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`Wrote ${categories.length} categories to ${outPath}`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
