// scripts/update-sprites.js
//
// Scrapes https://fortnite.gg/sprites ONCE and splits the results into two
// files based on a CONFIRMED list of which base sprites belong to which
// season (verified directly against the live page, not guessed):
//
//   data/season-current.json   <- the 12 "Override" / Season 4 base sprites
//   data/season-previous.json  <- the 25 Season 3 base sprites
//
// HISTORY (so nobody re-breaks this; three earlier approaches failed):
// v1 clicked the site's "C7 S4" / "C7 S3" filter buttons, trusting them to
//    narrow the page. They don't actually remove anything from the DOM —
//    both passes returned the same full mixed list.
// v2 tried walking up from each sprite to a guessed CSS class to figure out
//    its section. The guess rarely matched, causing both missing images
//    (an unrelated zero-size check wrongly skipped loading items) and
//    sprites landing in the wrong/both files inconsistently.
// v3 tried finding literal "Chapter 7 Season 4" header text on the page and
//    bucketing sprites by position relative to it. Turns out that text does
//    NOT appear in the list body at all — "C7 S4"/"C7 S3" exist ONLY once
//    each, as two small filter buttons sitting right next to each other
//    near the top of the page. Since nearly every sprite's position is
//    below both buttons, this put almost everything in one bucket.
// v4 (this version) uses a verified, hardcoded list of which base sprites
//    belong to each season instead of trying to detect it from the page at
//    all. This is simple and reliable BECAUSE the roster for a released
//    season doesn't change — if Epic adds sprites to the CURRENT season
//    later, update CURRENT_SEASON_SLUGS below; a new season replaces this
//    file's two lists entirely.
//
// Also fixed here: fortnite.gg itself is inconsistent about Bush's slug —
// most of its variants use "bush" (167-bush-sprite) but two use "bushranger"
// (105-loot-hacker-bushranger-sprite, 240-trick-or-treat-bushranger-sprite).
// SLUG_ALIASES normalizes that before grouping into categories.
//
// And: this page lazy-loads content as you scroll (239 sprites total), so
// the true scroll height grows while scrolling. forceLoadAllImages() now
// re-measures scrollHeight on every iteration instead of once up front —
// measuring it only once was why roughly half the images came back empty.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'data');
const SPRITES_URL = 'https://fortnite.gg/sprites';

// Verified against the live page on 2026-10-05. If Epic changes the season
// roster, update these two lists (and seasonName) — nothing else needs to
// change.
const CURRENT_SEASON_SLUGS = [
  'jonesy', 'adventure', 'bush', 'sonic', 'tails', 'shadow',
  '8-bit', 'jackrabbit', 'crown', 'killswitch', 'klombo', 'storm-scout',
];
const PREVIOUS_SEASON_SLUGS = [
  'water', 'earth', 'fire', 'duck', 'ghost', 'dream', 'demon', 'punk',
  'king', 'aura', 'striker', 'fishy', 'air', 'seven', 'boss', 'grim',
  'peeky-peely', 'llama', 'batman', 'zero-point', 'burnt-peanut',
  'vini-jr', 'pollo', 'john-wick', 'ironmouse',
];
const SEASON_DEFS = [
  { key: 'current', outFile: 'season-current.json', seasonName: 'Chapter 7 Season 4', slugs: CURRENT_SEASON_SLUGS },
  { key: 'previous', outFile: 'season-previous.json', seasonName: 'Chapter 7 Season 3', slugs: PREVIOUS_SEASON_SLUGS },
];

// Confirmed real-world slug inconsistencies on fortnite.gg — map the
// inconsistent spelling to the canonical one used everywhere else for that
// sprite's other variants.
const SLUG_ALIASES = {
  bushranger: 'bush',
};

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
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseSlug(rawSlug) {
  for (const variant of VARIANT_TOKENS) {
    if (rawSlug.startsWith(variant.slugToken + '-')) {
      const base = rawSlug.slice(variant.slugToken.length + 1);
      return { variant, baseSlug: SLUG_ALIASES[base] || base };
    }
  }
  return { variant: null, baseSlug: SLUG_ALIASES[rawSlug] || rawSlug };
}

// Scrolls to the bottom repeatedly, re-measuring scrollHeight each time,
// since this page loads more content in as you scroll (239 sprites total —
// measuring the height only once undercounts how far there is to go).
async function forceLoadAllImages(page) {
  await page.waitForTimeout(1000);

  let previousHeight = 0;
  for (let pass = 0; pass < 15; pass++) {
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach((img) => {
        img.loading = 'eager';
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (lazySrc && !img.src) img.src = lazySrc;
      });
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(500);

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break; // stopped growing, we're done
    previousHeight = currentHeight;
  }

  // One more eager-load pass now that the full page has loaded in, then
  // scroll back to the top before extracting.
  await page.evaluate(() => {
    document.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (lazySrc && !img.src) img.src = lazySrc;
    });
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1000);
}

async function extractEntries(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/sprites/"]'));
    const bySlug = {};

    for (const a of anchors) {
      // Burnt Peanut's href has no "-sprite" suffix (…/41-burnt-peanut)
      // unlike every other entry — the pattern below accepts that one
      // irregular case too.
      const match = a.getAttribute('href').match(/\/sprites\/(\d+)-([a-z0-9-]+?)(?:-sprite)?$/i);
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
      cat.baseName || baseSlug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const items = cat.items
      .map((it) => ({
        id: it.itemId,
        name: it.isBase ? catName : `${catName} ${it.variantLabel}`,
        image: it.image,
        released: it.released,
      }))
      .sort((a, b) => (a.id.endsWith('_normal') ? -1 : b.id.endsWith('_normal') ? 1 : 0));

    return { baseSlug, id: cat.id, name: catName, image: cat.baseImage, items };
  });
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
  await forceLoadAllImages(page);

  const rawEntries = await extractEntries(page);
  await browser.close();
  console.log(`Found ${rawEntries.length} total sprite entries on the page.`);

  const allCategories = buildCategories(rawEntries);

  const slugToSeasonKey = {};
  SEASON_DEFS.forEach((def) => def.slugs.forEach((s) => (slugToSeasonKey[s] = def.key)));

  const unmatched = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const season of SEASON_DEFS) {
    const categories = allCategories.filter((cat) => slugToSeasonKey[cat.baseSlug] === season.key);

    if (categories.length === 0) {
      console.error(`No categories matched "${season.seasonName}" — skipping this file so it isn't overwritten with empty data.`);
      continue;
    }

    const output = {
      version: 'auto-' + new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
      season: season.seasonName,
      categories: categories.map(({ id, name, image, items }) => ({ id, name, image, items })),
    };

    const outPath = path.join(OUT_DIR, season.outFile);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`Wrote ${categories.length} categories to ${outPath}`);
  }

  for (const cat of allCategories) {
    if (!(cat.baseSlug in slugToSeasonKey)) unmatched.push(cat.baseSlug);
  }
  if (unmatched.length > 0) {
    console.log(
      `\nNote: ${unmatched.length} base sprite(s) on the page don't belong to either known ` +
      `season list, so they weren't included in either file: ${unmatched.join(', ')}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
