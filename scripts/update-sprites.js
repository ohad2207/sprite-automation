// scripts/update-sprites.js
//
// Scrapes https://fortnite.gg/sprites ONCE and splits the results into two
// files by where each sprite physically sits on the page, relative to the
// real "Chapter 7 Season 4" / "Chapter 7 Season 3" section headers:
//
//   data/season-current.json   <- sprites positioned under the Season 4 header
//   data/season-previous.json  <- sprites positioned under the Season 3 header
//
// WHY THIS APPROACH (history, so nobody re-breaks this later):
// v1 clicked the site's "C7 S4" / "C7 S3" filter buttons and scraped twice,
// trusting the filter to narrow the DOM. In practice both passes returned
// the same full mixed list — the filter buttons apparently just scroll to
// or highlight a section rather than removing anything from the page, so
// clicking them didn't actually separate the two seasons at all.
// v2 tried to fix that by walking up from each sprite to the nearest
// ancestor matching a guessed CSS class, and falling back to a
// getBoundingClientRect() zero-size check when the guess didn't match. That
// introduced two real bugs: (1) legitimate sprites getting skipped (missing
// images) because an element can report a zero-size rect for a moment while
// still loading, and (2) sprites landing in the wrong file inconsistently,
// because the class-name guess rarely matched fortnite.gg's real markup.
// v3 (this version) does neither: it loads the page once, locates the real
// season header text directly (not a guessed class), reads its actual Y
// position, and buckets every sprite by comparing ITS OWN Y position to the
// header positions — order-agnostic (works whichever season's header comes
// first on the page) and never guesses at hidden/visible state.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'data');
const SPRITES_URL = 'https://fortnite.gg/sprites';

const SEASON_DEFS = [
  { key: 'current', outFile: 'season-current.json', seasonName: 'Chapter 7 Season 4', headerPattern: 'chapter\\s*7\\s*season\\s*4|(^|\\s)c7\\s*s4(\\s|$)' },
  { key: 'previous', outFile: 'season-previous.json', seasonName: 'Chapter 7 Season 3', headerPattern: 'chapter\\s*7\\s*season\\s*3|(^|\\s)c7\\s*s3(\\s|$)' },
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
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseSlug(slug) {
  for (const variant of VARIANT_TOKENS) {
    if (slug.startsWith(variant.slugToken + '-')) {
      return { variant, baseSlug: slug.slice(variant.slugToken.length + 1) };
    }
  }
  return { variant: null, baseSlug: slug };
}

// Generous on purpose — a shortened version of this previously left ~half
// the images unresolved. Don't shorten without re-checking image coverage.
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

// Single evaluate() call that returns BOTH every sprite anchor (with its
// real page position) AND the real position of each season header, found by
// matching an element's OWN direct text (not its descendants' text, so we
// don't match a big wrapper that merely contains the words somewhere deep
// inside it) against the header patterns.
async function extractWithPositions(page, seasonDefs) {
  return page.evaluate((defs) => {
    function topOf(el) {
      const r = el.getBoundingClientRect();
      return r.top + window.scrollY;
    }
    function ownText(el) {
      return Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
    }

    const headerTop = {};
    const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,button,a'));
    for (const el of candidates) {
      const text = ownText(el);
      if (!text || text.length > 40) continue;
      for (const def of defs) {
        if (def.key in headerTop) continue; // keep only the first (topmost) occurrence
        if (new RegExp(def.headerPattern, 'i').test(text)) {
          headerTop[def.key] = topOf(el);
        }
      }
    }

    const anchors = Array.from(document.querySelectorAll('a[href*="/sprites/"]'));
    const bySlug = {};
    for (const a of anchors) {
      const match = a.getAttribute('href').match(/\/sprites\/(\d+)-([a-z0-9-]+)-sprite/i);
      if (!match) continue;
      const [, numericId, slug] = match;

      if (!bySlug[numericId]) {
        bySlug[numericId] = {
          numericId, slug: slug.toLowerCase(), name: '', image: '', released: true, top: topOf(a),
        };
      }
      const entry = bySlug[numericId];
      entry.top = Math.min(entry.top, topOf(a)); // the two paired anchors (image+text) may differ slightly

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

    return { entries: Object.values(bySlug), headerTop };
  }, seasonDefs.map((d) => ({ key: d.key, headerPattern: d.headerPattern })));
}

// Buckets each entry into whichever season's header sits closest ABOVE it
// on the page — order-agnostic: works whether Season 4 or Season 3 appears
// first in the document.
function assignSeasons(entries, headerTop, seasonDefs) {
  const boundaries = seasonDefs
    .filter((d) => d.key in headerTop)
    .map((d) => ({ key: d.key, top: headerTop[d.key] }))
    .sort((a, b) => a.top - b.top);

  const bucket = {};
  seasonDefs.forEach((d) => (bucket[d.key] = []));

  for (const entry of entries) {
    let assigned = null;
    for (const b of boundaries) {
      if (entry.top >= b.top) assigned = b.key;
    }
    if (assigned) bucket[assigned].push(entry);
  }
  return bucket;
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

    return { id: cat.id, name: catName, image: cat.baseImage, items };
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

  const { entries, headerTop } = await extractWithPositions(page, SEASON_DEFS);
  await browser.close();

  console.log(`Found ${entries.length} total sprite entries.`);
  console.log('Header positions found:', headerTop);

  const missingHeaders = SEASON_DEFS.filter((d) => !(d.key in headerTop));
  if (missingHeaders.length > 0) {
    console.error(
      'Could not find a page position for: ' +
      missingHeaders.map((d) => d.seasonName).join(', ') +
      ' — the header text/pattern may need updating. Not writing any files this run.'
    );
    process.exit(1);
  }

  const buckets = assignSeasons(entries, headerTop, SEASON_DEFS);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const season of SEASON_DEFS) {
    const rawEntries = buckets[season.key];
    console.log(`${season.seasonName}: ${rawEntries.length} entries`);

    if (rawEntries.length === 0) {
      console.error(`No entries assigned to "${season.seasonName}" — skipping this file so it isn't overwritten with empty data.`);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
