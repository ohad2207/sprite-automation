const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SPRITES_API_URL = 'https://prod.fn-api.cc/v1/sprites';
const REQUEST_TIMEOUT_MS = 30_000;

const VARIANT_ALIASES = {
  a: { id: 'normal', label: null },
  base: { id: 'normal', label: null },
  default: { id: 'normal', label: null },
  normal: { id: 'normal', label: null },

  candy: { id: 'gummy', label: 'Gummy' },
  gummy: { id: 'gummy', label: 'Gummy' },
  gold: { id: 'gold', label: 'Gold' },
  galaxy: { id: 'galaxy', label: 'Galaxy' },
  gem: { id: 'gem', label: 'Gem' },
  holofoil: { id: 'holofoil', label: 'Holofoil' },
  cube: { id: 'cube', label: 'Cube' },
  quack: { id: 'quack', label: 'Quack' },

  cheatmaster: { id: 'cheatmaster', label: 'Cheat Master' },
  cheat_master: { id: 'cheatmaster', label: 'Cheat Master' },

  loothacker: { id: 'hacker', label: 'Loot Hacker' },
  loot_hacker: { id: 'hacker', label: 'Loot Hacker' },
  hacker: { id: 'hacker', label: 'Loot Hacker' },

  bountyhunter: { id: 'bountyhunter', label: 'Bounty Hunter' },
  bounty_hunter: { id: 'bountyhunter', label: 'Bounty Hunter' },

  trickortreat: { id: 'tricktreat', label: 'Trick or Treat' },
  trick_or_treat: { id: 'tricktreat', label: 'Trick or Treat' },
};

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function humanize(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function stripSpriteSuffix(name) {
  return String(name || '')
    .replace(/\s+sprite$/i, '')
    .trim();
}

function parseSeason(rawSeason) {
  const match = String(rawSeason || '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .match(/^CH(\d+)S(\d+)$/);

  if (!match) {
    return null;
  }

  const [, chapter, season] = match;

  return {
    id: `c${chapter}s${season}`,
    filename: `c${chapter}s${season}.json`,
    displayName: `Chapter ${chapter} Season ${season}`,
  };
}

function getImage(record) {
  return record?.images?.largeIcon || record?.images?.icon || '';
}

function getVariantInfo(rawVariant) {
  const key = slugify(rawVariant);

  if (VARIANT_ALIASES[key]) {
    return VARIANT_ALIASES[key];
  }

  return {
    id: key || 'normal',
    label: key ? humanize(rawVariant) : null,
  };
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read valid JSON from ${filePath}: ${error.message}`,
    );
  }
}

function getExistingSeasonData(seasonInfo) {
  const filePath = path.join(DATA_DIR, seasonInfo.filename);

  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      data: {
        version: '',
        season: seasonInfo.displayName,
        categories: [],
      },
    };
  }

  const data = loadJson(filePath);

  if (!Array.isArray(data.categories)) {
    throw new Error(
      `${seasonInfo.filename} has no valid "categories" array. No files were changed.`,
    );
  }

  return {
    filePath,
    exists: true,
    data,
  };
}

function buildIncomingCategory(family, seasonInfo) {
  const categoryName = stripSpriteSuffix(family.name);

  if (!categoryName) {
    throw new Error(
      `A sprite family in ${seasonInfo.id} has no usable name.`,
    );
  }

  const categoryId = slugify(categoryName);

  if (!categoryId) {
    throw new Error(
      `Could not create a stable ID for "${categoryName}".`,
    );
  }

  const rawVariants =
    Array.isArray(family.variants) && family.variants.length > 0
      ? family.variants
      : [family];

  const itemIds = new Set();
  const items = [];

  for (const variant of rawVariants) {
    const variantInfo = getVariantInfo(variant.variant);
    const itemId = `${categoryId}_${variantInfo.id}`;

    if (itemIds.has(itemId)) {
      throw new Error(
        `Duplicate source ID "${itemId}" in season ${seasonInfo.id}. No files were changed.`,
      );
    }

    itemIds.add(itemId);

    items.push({
      id: itemId,
      name: variantInfo.label
        ? `${categoryName} ${variantInfo.label}`
        : categoryName,
      image: getImage(variant) || getImage(family),
    });
  }

  items.sort((left, right) => {
    if (left.id.endsWith('_normal')) return -1;
    if (right.id.endsWith('_normal')) return 1;
    return left.name.localeCompare(right.name);
  });

  return {
    id: categoryId,
    name: categoryName,
    image: getImage(family) || items[0]?.image || '',
    items,
  };
}

function mergeCategory(existingCategory, incomingCategory) {
  const existingItems = Array.isArray(existingCategory?.items)
    ? existingCategory.items
    : [];

  const existingItemsById = new Map(
    existingItems.map((item) => [item.id, item]),
  );

  const mergedItems = [...existingItems];
  let changed = false;

  for (const incomingItem of incomingCategory.items) {
    const existingItem = existingItemsById.get(incomingItem.id);

    if (!existingItem) {
      mergedItems.push(incomingItem);
      changed = true;
      continue;
    }

    const mergedItem = {
      ...existingItem,
      id: incomingItem.id,
      name: incomingItem.name,
      image: incomingItem.image || existingItem.image || '',
    };

    if (JSON.stringify(mergedItem) !== JSON.stringify(existingItem)) {
      const index = mergedItems.findIndex(
        (item) => item.id === incomingItem.id,
      );

      mergedItems[index] = mergedItem;
      changed = true;
    }
  }

  mergedItems.sort((left, right) => {
    if (left.id.endsWith('_normal')) return -1;
    if (right.id.endsWith('_normal')) return 1;
    return left.name.localeCompare(right.name);
  });

  const mergedCategory = {
    ...existingCategory,
    id: incomingCategory.id,
    name: incomingCategory.name,
    image: incomingCategory.image || existingCategory.image || '',
    items: mergedItems,
  };

  if (
    JSON.stringify(mergedCategory) !== JSON.stringify(existingCategory)
  ) {
    changed = true;
  }

  return { category: mergedCategory, changed };
}

function mergeSeason(existingData, seasonInfo, incomingCategories) {
  const existingCategories = Array.isArray(existingData.categories)
    ? existingData.categories
    : [];

  const categoriesById = new Map(
    existingCategories.map((category) => [category.id, category]),
  );

  const mergedCategories = [...existingCategories];
  let changed = false;

  for (const incomingCategory of incomingCategories) {
    const existingCategory = categoriesById.get(incomingCategory.id);

    if (!existingCategory) {
      mergedCategories.push(incomingCategory);
      changed = true;
      continue;
    }

    const result = mergeCategory(existingCategory, incomingCategory);

    if (result.changed) {
      const index = mergedCategories.findIndex(
        (category) => category.id === incomingCategory.id,
      );

      mergedCategories[index] = result.category;
      changed = true;
    }
  }

  if (!existingData.season) {
    changed = true;
  }

  if (!changed) {
    return {
      changed: false,
      data: existingData,
    };
  }

  return {
    changed: true,
    data: {
      ...existingData,
      version: `auto-${new Date().toISOString().slice(0, 10)}`,
      updatedAt: new Date().toISOString(),
      season: existingData.season || seasonInfo.displayName,
      categories: mergedCategories,
    },
  };
}

async function fetchSpriteCatalog() {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(SPRITES_API_URL, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Sprite API returned HTTP ${response.status}.`,
      );
    }

    let payload;

    try {
      payload = await response.json();
    } catch {
      throw new Error('Sprite API returned invalid JSON.');
    }

    if (
      payload?.status !== 200 ||
      !Array.isArray(payload?.data) ||
      payload.data.length === 0
    ) {
      throw new Error(
        'Sprite API response is empty or has an unexpected shape.',
      );
    }

    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log(`Fetching sprite data from ${SPRITES_API_URL}`);

  // שום קובץ לא נכתב לפני שה־API הוחזר ונבדק במלואו.
  const families = await fetchSpriteCatalog();
  const bySeason = new Map();

  for (const family of families) {
    const seasonInfo = parseSeason(family.season);

    if (!seasonInfo) {
      throw new Error(
        `Unknown season value "${family.season}" for "${family.name}". No files were changed.`,
      );
    }

    if (!bySeason.has(seasonInfo.id)) {
      bySeason.set(seasonInfo.id, {
        seasonInfo,
        categories: [],
      });
    }

    bySeason
      .get(seasonInfo.id)
      .categories.push(buildIncomingCategory(family, seasonInfo));
  }

  if (bySeason.size === 0) {
    throw new Error('No valid seasons found. No files were changed.');
  }

  const pendingWrites = [];

  for (const { seasonInfo, categories } of bySeason.values()) {
    const existing = getExistingSeasonData(seasonInfo);
    const merged = mergeSeason(
      existing.data,
      seasonInfo,
      categories,
    );

    if (merged.changed || !existing.exists) {
      pendingWrites.push({
        filePath: existing.filePath,
        data: merged.data,
        categoryCount: categories.length,
      });
    }
  }

  if (pendingWrites.length === 0) {
    console.log('No sprite changes found. No files were updated.');
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const file of pendingWrites) {
    fs.writeFileSync(
      file.filePath,
      `${JSON.stringify(file.data, null, 2)}\n`,
      'utf8',
    );

    console.log(
      `Updated ${path.basename(file.filePath)} with ${file.categoryCount} source categories.`,
    );
  }

  console.log(
    `Finished: updated ${pendingWrites.length} season file(s).`,
  );
}

main().catch((error) => {
  console.error(`Sprite update failed: ${error.message}`);
  process.exit(1);
});
