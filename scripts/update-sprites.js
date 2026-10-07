const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'data');
const SPRITES_URL = 'https://fortnite.gg/sprites';

// רשימת הספרייטים של העונה הקודמת — קבועה, כדי שהעונה הנוכחית
// תכלול אוטומטית כל ספרייט חדש שלא שייך לרשימה זו.
const PREVIOUS_SEASON_SLUGS = [
  'water', 'earth', 'fire', 'duck', 'ghost', 'dream', 'demon', 'punk',
  'king', 'aura', 'striker', 'fishy', 'air', 'seven', 'boss', 'grim',
  'peeky-peely', 'llama', 'batman', 'zero-point', 'burnt-peanut',
  'vini-jr', 'pollo', 'john-wick', 'ironmouse',
];

const PREVIOUS_SEASON_NAME = 'Chapter 7 Season 3';
const CURRENT_SEASON_NAME = 'Chapter 7 Season 4';

// תיקון לחוסר אחידות בשם Bush באתר.
const SLUG_ALIASES = {
  bushranger: 'bush',
};

// חשוב: Fortnite.gg משתמש בשני איותים של Cheat Master:
// cheat-master-X וגם cheatmaster-X.
// שניהם מקבלים את אותו id ולכן נכנסים לאותה קטגוריה.
const VARIANT_TOKENS = [
  { slugToken: 'trick-or-treat', id: 'tricktreat', label: 'Trick or Treat' },
  { slugToken: 'bounty-hunter', id: 'bountyhunter', label: 'Bounty Hunter' },
  { slugToken: 'loot-hacker', id: 'hacker', label: 'Loot Hacker' },
  { slugToken: 'cheat-master', id: 'cheatmaster', label: 'Cheat Master' },
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

    const bySlug = {};

    for (const a of anchors) {
      const match = a
        .getAttribute('href')
        ?.match(/\/sprites\/(\d+)-([a-z0-9-]+?)(?:-sprite)?$/i);

      if (!match) {
        continue;
      }

      const [, numericId, slug] = match;

      if (!bySlug[numericId]) {
        bySlug[numericId] = {
          numericId,
          slug: slug.toLowerCase(),
          name: '',
          image: '',
          released: true,
        };
      }

      const entry = bySlug[numericId];
      const img = a.querySelector('img');

      if (img) {
        const src =
          img.currentSrc ||
          img.src ||
          img.getAttribute('data-src') ||
          '';

        if (src && src.includes('/sprites/icons/')) {
          entry.image = src;
        }
      }

      const text = a.textContent.trim();

      if (text && !entry.name) {
        entry.name = text;
      }

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
      categories[baseSlug] = {
        id: slugify(baseSlug),
        baseName: null,
        baseImage: '',
        items: [],
      };

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
      baseSlug
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const items = cat.items
      .map((item) => ({
        id: item.itemId,
        name: item.isBase
          ? catName
          : `${catName} ${item.variantLabel}`,
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
      id: cat.id,
      name: catName,
      image: cat.baseImage,
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

  console.log(`Found ${rawEntries.length} total sprite entries on the page.`);

  const allCategories = buildCategories(rawEntries);
  const previousSet = new Set(PREVIOUS_SEASON_SLUGS);

  const previousCategories = allCategories.filter((cat) =>
    previousSet.has(cat.baseSlug),
  );

  const currentCategories = allCategories.filter(
    (cat) => !previousSet.has(cat.baseSlug),
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
        `No categories matched "${file.seasonName}" — skipping this file.`,
      );
      continue;
    }

    const output = {
      version: `auto-${new Date().toISOString().slice(0, 10)}`,
      updatedAt: new Date().toISOString(),
      season: file.seasonName,
      categories: file.categories.map(({ id, name, image, items }) => ({
        id,
        name,
        image,
        items,
      })),
    };

    const outPath = path.join(OUT_DIR, file.outFile);

    fs.writeFileSync(
      outPath,
      JSON.stringify(output, null, 2),
      'utf-8',
    );

    console.log(
      `Wrote ${file.categories.length} categories to ${outPath}`,
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
