// scripts/update-sprites.js
//
// Scrapes https://fortnite.gg/sprites and rebuilds data/sprites.json in the
// same {categories:[{id,name,image,items:[{id,name,image}]}]} shape used by
// the Fortnite Sprite Tracker app.
//
// WHY PLAYWRIGHT (a real headless browser) INSTEAD OF A PLAIN fetch():
// fortnite.gg/sprites is a JS-rendered page. A lot of its sprite images are
// lazy-loaded — the raw HTML for items below the fold doesn't carry a real
// <img src>, only a placeholder, until JS fills it in as you scroll. A plain
// HTTP fetch would only ever see the placeholders. Playwright actually runs
// the page like a browser, so we can force every image to resolve before
// reading the DOM.
//
// WHAT'S RELIABLE vs. GUESSED ABOUT THE PAGE:
// - Every sprite links to a URL shaped like /sprites/<numericId>-<slug>-sprite
//   (e.g. /sprites/184-gold-jonesy-sprite). This is confirmed and very stable
//   — the numeric ID and slug both encode the variant, which we parse below.
// - Image files are confirmed to live under /img/x/sprites/icons/ as .webp.
// - We do NOT rely on fortnite.gg's CSS class names anywhere (those weren't
//   verified and could change at any time) — only on the URL/slug patterns
//   above, which are far less likely to shift silently.
//
// KNOWN RISK: fortnite.gg may rate-limit or block requests from GitHub
// Actions' shared IP ranges even though this works from a normal browser.
// If runs start failing, see the README's "If scraping gets blocked" section.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA_PATH = path.join(__dirname, '..', 'data', 'sprites.json');
const SPRITES_URL = 'https://fortnite.gg/sprites';

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

// Splits a URL slug like "gold-jonesy" or "jonesy" into { variant, baseSlug }.
// The slug has already had the trailing "-sprite" removed by the caller.
function parseSlug(slug) {
  for (const variant of VARIANT_TOKENS) {
    if (slug.startsWith(variant.slugToken + '-')) {
      return { variant, baseSlug: slug.slice(variant.slugToken.length + 1) };
    }
  }
  return { variant: null, baseSlug: slug };
}

async function scrapeSpritePage() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  console.log('Opening', SPRITES_URL);
  await page.goto(SPRITES_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Give any initial lazy-load library a moment, then force every image to
  // resolve immediately instead of waiting for real scroll/intersection.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (lazySrc && !img.src) img.src = lazySrc;
    });
  });

  // Belt-and-suspenders: also physically scroll through the page in case
  // some images only resolve on a real intersection event rather than just
  // having their attributes flipped above.
  await page.evaluate(async () => {
    const step = window.innerHeight;
    const scrollHeight = document.body.scrollHeight;
    for (let y = 0; y < scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1000);

  const rawEntries = await page.evaluate(() => {
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

      // "Unreleased" shows up as plain text near the entry instead of the
      // Owned/Mastered buttons — check the anchor's own container for it.
      const container = a.closest('div, li, article') || a.parentElement;
      if (container && /Unreleased/i.test(container.textContent)) {
        entry.released = false;
      }
    }

    return Object.values(bySlug);
  });

  await browser.close();
  return rawEntries;
}

function buildCategories(rawEntries) {
  const categories = {}; // baseSlug -> { id, baseName, baseImage, items: [] }
  const order = [];

  for (const entry of rawEntries) {
    const { variant, baseSlug } = parseSlug(entry.slug);

    if (!categories[baseSlug]) {
      categories[baseSlug] = { id: slugify(baseSlug), baseName: null, baseImage: '', items: [] };
      order.push(baseSlug);
    }
    const cat = categories[baseSlug];

    if (!variant) {
      // This IS the base/"Normal" variant — its scraped name is the
      // category's real display name (e.g. "Jonesy", "8-Bit", "X-Ray").
      cat.baseName = entry.name;
      cat.baseImage = entry.image || cat.baseImage;
    }

    cat.items.push({
      itemId: `${slugify(baseSlug)}_${variant ? variant.id : 'normal'}`,
      isBase: !variant,
      variantLabel: variant ? variant.label : null,
      image: entry.image || '',
      released: entry.released,
      scrapedName: entry.name, // fallback only, used if baseName never shows up
    });
  }

  return order.map((baseSlug) => {
    const cat = categories[baseSlug];
    // Fallback if the base/"Normal" variant wasn't found at all (e.g. it's
    // the one that's unreleased and missing from the scrape): title-case
    // the slug instead of leaving the category nameless.
    const catName =
      cat.baseName ||
      baseSlug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

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

async function main() {
  const rawEntries = await scrapeSpritePage();
  console.log(`Scraped ${rawEntries.length} sprite entries`);

  if (rawEntries.length === 0) {
    throw new Error(
      'Scrape returned 0 entries — fortnite.gg likely blocked or changed structure. ' +
      'Not overwriting sprites.json with empty data.'
    );
  }

  const categories = buildCategories(rawEntries);

  const output = {
    version: 'auto-' + new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    categories,
  };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Wrote ${categories.length} categories to`, DATA_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
