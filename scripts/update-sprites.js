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
// This replaces the earlier version, which scraped the page's default "All
// Seasons" view and mixed both seasons into one undifferentiated list.
//
// See the previous version's comments (kept below) for why Playwright is
// used instead of a plain fetch, and what the scraper relies on vs. doesn't.

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

// Clicks the season filter control that exactly matches `label` (e.g. "C7 S4").
// Uses a text-match locator rather than a guessed CSS selector/class name,
// since the underlying markup (button? pill? dropdown option?) isn't known —
// matching by visible text is far more resilient to a layout change.
async function selectSeasonFilter(page, label) {
  const locator = page.getByText(label, { exact: true });
  await locator.first().click();
  await page.waitForTimeout(1200); // let the filtered list re-render
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

async function scrapeSeason(page, filterLabel) {
  console.log(`Selecting season filter: ${filterLabel}`);
  await selectSeasonFilter(page, filterLabel);
  await forceLoadAllImages(page);
  const rawEntries = await extractEntries(page);
  console.log(`  -> ${rawEntries.length} entries for ${filterLabel}`);
  return rawEntries;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  console.log('Opening', SPRITES_URL);
  await page.goto(SPRITES_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await forceLoadAllImages(page); // let the default "All Seasons" view settle first

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const season of SEASONS) {
    const rawEntries = await scrapeSeason(page, season.filterLabel);

    if (rawEntries.length === 0) {
      console.error(
        `No entries found for "${season.filterLabel}" — skipping this file so it isn't ` +
        `overwritten with empty data. (Page structure or filter label may have changed.)`
      );
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
