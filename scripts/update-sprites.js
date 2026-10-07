const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'data');
const SPRITES_URL = 'https://fortnite.gg/sprites';

const PREVIOUS_SEASON_SLUGS = [
  'water',
  'earth',
  'fire',
  'duck',
  'ghost',
  'dream',
  'demon',
  'punk',
  'king',
  'aura',
  'striker',
  'fishy',
  'air',
  'seven',
  'boss',
  'grim',
  'peeky-peely',
  'llama',
  'batman',
  'zero-point',
  'burnt-peanut',
  'vini-jr',
  'pollo',
  'john-wick',
  'ironmouse',
];

const PREVIOUS_SEASON_NAME = 'Chapter 7 Season 3';
const CURRENT_SEASON_NAME = 'Chapter 7 Season 4';

const SLUG_ALIASES = {
  bushranger: 'bush',
};

const VARIANT_TOKENS = [
  { slugToken: 'trick-or-treat', id: 'tricktreat', label: 'Trick or Treat' },
  { slugToken: 'bounty-hunter', id: 'bountyhunter', label: 'Bounty Hunter' },
  { slugToken: 'loot-hacker', id: 'hacker', label: 'Loot Hacker' },
  { slugToken: 'cheat-master', id: 'cheatmaster', label: 'Cheat Master' },

  // Fortnite.gg uses this spelling for some sprites:
  // cheatmaster-x-ray, cheatmaster-onigiri, etc.
  { slugToken: 'cheatmaster', id: 'cheatmaster', label: 'Cheat Master' },

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

// מנרמל slug של קטגוריה לפני בדיקת העונה.
// כך גם zero-point-sprite וגם zero-point מזוהים כאותו ספרייט.
function canonicalSeasonSlug(slug) {
  return slug
    .toLowerCase()
    .replace(/-sprite$/, '')
    .trim();
}

const PREVIOUS_SEASON_SET = new Set(
  PREVIOUS_SEASON_SLUGS.map(canonicalSeasonSlug),
);

function isPreviousSeasonCategory(category) {
  return PREVIOUS_SEASON_SET.has(
    canonicalSeasonSlug(category.baseSlug),
  );
}

function parseSlug(rawSlug) {
  for (const variant of VARIANT_TOKENS) {
    if (rawSlug.startsWith(`${variant.slugToken}-`)) {
      const base = rawSlug.slice(variant.slugToken.length + 1);

      return {
        variant,
        baseSlug: SLUG_ALIASES[base] || base,
      };
    }
  }

  return {
    variant: null,
    baseSlug: SLUG_ALIASES[rawSlug] || rawSlug,
  };
}

async function forceLoadAllImages(page) {
  await page.waitForTimeout(1000);

  let previousHeight = 0;

  for (let pass = 0; pass < 15; pass++) {
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach((img) => {
        img.loading = 'eager';

        const lazySrc =
          img.getAttribute('data-src') ||
          img.getAttribute('data-lazy-src');

        if (lazySrc && !img.src) {
          img.src = lazySrc;
        }
      });

      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(500);

    const currentHeight = await page.evaluate(
      () => document.body.scrollHeight,
    );

    if (currentHeight === previousHeight) {
      break;
    }

    previousHeight = currentHeight;
  }

  await page.evaluate(() => {
    document.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';

      const lazySrc =
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src');

      if (lazySrc && !img.src) {
        img.src = lazySrc;
      }
    });

    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(1000);
}

async function extractEntries(page) {
  return page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll('a[href*="/sprites/"]'),
    );

    const byNumericId = {};

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';

      // תומך גם ב-Burnt Peanut, שהקישור שלו אינו מסתיים ב-sprite.
      const match = href.match(
        /\/sprites\/(\d+)-([a-z0-9-]+?)(?:-sprite)?$/i,
      );

      if (!match) {
        continue;
      }

      const [, numericId, slug] = match;

      if (!byNumericId[numericId]) {
        byNumericId[numericId] = {
          numericId,
          slug: slug.toLowerCase(),
          name: '',
          image: '',
          released: true,
        };
      }

      const entry = byNumericId[numericId];
      const image = anchor.querySelector('img');

      if (image) {
        const src =
          image.currentSrc ||
          image.src ||
          image.getAttribute('data-src') ||
          '';

        if (src.includes('/sprites/icons/')) {
          entry.image = src;
        }
      }

      const text = anchor.textContent.trim();

      if (text && !entry.name) {
        entry.name = text;
      }

      const container =
        anchor.closest('div, li, article') || anchor.parentElement;

      if (container && /Unreleased/i.test(container.textContent)) {
        entry.released = false;
      }
    }

    return Object.values(byNumericId);
  });
}

function buildCategories(rawEntries) {
  const categories = {};
  const order = [];

  for (const entry of rawEntries) {
    const { variant, baseSlug } = parseSlug(entry.slug);

    if (!categories[baseSlug]) {
      categories[baseSlug] = {
        id: slugify(baseSlug),
        baseName: null,
        baseImage: '',
        items: [],
      };

      order.push(baseSlug);
    }

    const category = categories[baseSlug];

    if (!variant) {
      category.baseName = entry.name;
      category.baseImage = entry.image || category.baseImage;
    }

    category.items.push({
      itemId: `${slugify(baseSlug)}_${
        variant ? variant.id : 'normal'
      }`,
      isBase: !variant,
      variantLabel: variant ? variant.label : null,
      image: entry.image || '',
      released: entry.released,
    });
  }

  return order.map((baseSlug) => {
    const category = categories[baseSlug];

    const categoryName =
      category.baseName ||
      baseSlug
        .split('-')
        .map(
          (word) =>
            word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(' ');

    const items = category.items
      .map((item) => ({
        id: item.itemId,
        name: item.isBase
          ? categoryName
          : `${categoryName} ${item.variantLabel}`,
        image: item.image,
        released: item.released,
      }))
      .sort((a, b) => {
        if (a.id.endsWith('_normal')) return -1;
        if (b.id.endsWith('_normal')) return 1;
        return 0;
      });

    return {
      baseSlug,
      id: category.id,
      name: categoryName,
      image: category.baseImage,
      items,
    };
  });
}

async function main() {
  const browser = await chromium.launch();

  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/128.0.0.0 Safari/537.36',
  });

  console.log('Opening', SPRITES_URL);

  await page.goto(SPRITES_URL, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  await forceLoadAllImages(page);

  const rawEntries = await extractEntries(page);

  await browser.close();

  console.log(
    `Found ${rawEntries.length} total sprite entries on the page.`,
  );

  const allCategories = buildCategories(rawEntries);

  const previousCategories = allCategories.filter(
    isPreviousSeasonCategory,
  );

  const currentCategories = allCategories.filter(
    (category) => !isPreviousSeasonCategory(category),
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = [
    {
      outFile: 'season-previous.json',
      seasonName: PREVIOUS_SEASON_NAME,
      categories: previousCategories,
    },
    {
      outFile: 'season-current.json',
      seasonName: CURRENT_SEASON_NAME,
      categories: currentCategories,
    },
  ];

  for (const file of files) {
    if (file.categories.length === 0) {
      console.error(
        `No categories matched "${file.seasonName}" — skipping file.`,
      );
      continue;
    }

    const output = {
      version: `auto-${new Date().toISOString().slice(0, 10)}`,
      updatedAt: new Date().toISOString(),
      season: file.seasonName,
      categories: file.categories.map(
        ({ id, name, image, items }) => ({
          id,
          name,
          image,
          items,
        }),
      ),
    };

    const outputPath = path.join(OUT_DIR, file.outFile);

    fs.writeFileSync(
      outputPath,
      JSON.stringify(output, null, 2),
      'utf-8',
    );

    console.log(
      `Wrote ${file.categories.length} categories to ${outputPath}`,
    );
  }

  console.log(
    `Breakdown: ${previousCategories.length} previous-season categories, ` +
      `${currentCategories.length} current-season categories.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
