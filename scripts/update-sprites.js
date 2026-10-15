
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SPRITES_API_URL = 'https://prod.fn-api.cc/v1/sprites';
const REQUEST_TIMEOUT_MS = 30_000;
const CURRENT_SEASON_FILENAME = 'season-current.json';

// Known false-positive sprites that should never appear in the tracker.
const EXCLUDED_SPRITE_IDS = new Set(['overshield_reaper']);

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
    .replace(/\b\w/g, c => c.toUpperCase());
}

function stripSpriteSuffix(name) {
  return String(name || '').replace(/\s+sprite$/i, '').trim();
}

function parseSeason(rawSeason) {
  const match = String(rawSeason || '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .match(/^CH(\d+)S(\d+)$/);

  if (!match) return null;

  const [, chapter, season] = match;

  return {
    id: `c${chapter}s${season}`,
    filename: `c${chapter}s${season}.json`,
    displayName: `Chapter ${chapter} Season ${season}`,
    chapter: Number(chapter),
    season: Number(season),
  };
}

function compareSeasons(a, b) {
  return a.chapter - b.chapter || a.season - b.season;
}

function getImage(record) {
  return record?.images?.largeIcon || record?.images?.icon || '';
}

// מסנן רק פריטים שהמקור מסמן במפורש כלא משוחררים.
// שדות חסרים אינם נחשבים להוכחה שהפריט לא יצא.
function isExplicitlyUnreleased(record) {
  if (!record || typeof record !== 'object') return false;

  // Support common release flags used by sprite data sources.
  if (
    record.released === false ||
    record.isReleased === false ||
    record.is_released === false ||
    record.neverReleased === true ||
    record.never_released === true ||
    record.unreleased === true
  ) {
    return true;
  }

  const rawStatus = record.releaseStatus ?? record.release_status ?? record.release_state ?? '';
  const status = String(rawStatus)
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');

  if ([
    'unreleased',
    'never_released',
    'not_released',
    'upcoming',
    'future',
    'pending_release',
  ].includes(status)) {
    return true;
  }

  // Exclude records with a clearly future release date, when the source provides one.
  const rawReleaseDate = record.releaseDate ?? record.release_date ?? record.releaseAt ?? record.release_at;
  if (rawReleaseDate) {
    const releaseTime = Date.parse(rawReleaseDate);
    if (Number.isFinite(releaseTime) && releaseTime > Date.now()) return true;
  }

  return false;
}

function getVariantInfo(rawVariant) {
  const key = slugify(rawVariant);

  return VARIANT_ALIASES[key] || {
    id: key || 'normal',
    label: key ? humanize(rawVariant) : null,
  };
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read valid JSON from ${filePath}: ${error.message}`
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
      `${seasonInfo.filename} has no valid categories array.`
    );
  }

  return { filePath, exists: true, data };
}

function buildIncomingCategory(family, seasonInfo, isCurrentSeason) {
  const categoryName = stripSpriteSuffix(family.name);
  const categoryId = slugify(categoryName);

  if (!categoryName || !categoryId) {
    throw new Error(`Invalid sprite family in ${seasonInfo.id}.`);
  }

  const rawVariants =
    Array.isArray(family.variants) && family.variants.length
      ? family.variants
      : [family];

  const items = [];
  const filteredItemIds = new Set();
  const seenIds = new Set();

  for (const variant of rawVariants) {
    const variantInfo = getVariantInfo(variant.variant);
    const itemId = `${categoryId}_${variantInfo.id}`;

    if (seenIds.has(itemId)) {
      throw new Error(
        `Duplicate source ID "${itemId}" in ${seasonInfo.id}.`
      );
    }
    seenIds.add(itemId);

    // Explicitly excluded false-positive IDs must be removed from old data too.
    if (EXCLUDED_SPRITE_IDS.has(itemId)) {
      filteredItemIds.add(itemId);
      continue;
    }

    // Explicit release status applies to every season.
    const explicitlyUnreleased =
      isExplicitlyUnreleased(family) ||
      isExplicitlyUnreleased(variant);

    // "enabled" is a live switch, not a historical release record.
    // Use it only for the current season.
    const disabledNow =
      isCurrentSeason &&
      (family.enabled === false || variant.enabled === false);

    if (explicitlyUnreleased || disabledNow) {
      filteredItemIds.add(itemId);
      continue;
    }

    const item = {
      id: itemId,
      name: variantInfo.label
        ? `${categoryName} ${variantInfo.label}`
        : categoryName,
      image: getImage(variant) || getImage(family),
    };

    if (typeof variant.released === 'boolean') {
      item.released = variant.released;
    } else if (typeof variant.isReleased === 'boolean') {
      item.released = variant.isReleased;
    }

    items.push(item);
  }

  items.sort((a, b) => {
    if (a.id.endsWith('_normal')) return -1;
    if (b.id.endsWith('_normal')) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    category: {
      id: categoryId,
      name: categoryName,
      image: getImage(family) || items[0]?.image || '',
      items,
    },
    filteredItemIds: [...filteredItemIds],
  };
}

function mergeCategory(existingCategory, incomingEntry) {
  const incomingCategory = incomingEntry.category;
  const filteredIds = new Set(incomingEntry.filteredItemIds);
  const existingItems = Array.isArray(existingCategory?.items)
    ? existingCategory.items
    : [];

  // Remove filtered IDs and items already marked unreleased.
  const mergedItems = existingItems.filter(item =>
    !filteredIds.has(item.id) &&
    !isExplicitlyUnreleased(item)
  );

  const existingItemsById = new Map(
    existingItems.map(item => [item.id, item])
  );

  for (const incomingItem of incomingCategory.items) {
    const oldItem = existingItemsById.get(incomingItem.id);

    if (!oldItem) {
      mergedItems.push(incomingItem);
      continue;
    }

    const mergedItem = {
      ...oldItem,
      ...incomingItem,
      image: incomingItem.image || oldItem.image || '',
    };

    const index = mergedItems.findIndex(
      item => item.id === incomingItem.id
    );

    if (index === -1) {
      mergedItems.push(mergedItem);
    } else {
      mergedItems[index] = mergedItem;
    }
  }

  mergedItems.sort((a, b) => {
    if (a.id.endsWith('_normal')) return -1;
    if (b.id.endsWith('_normal')) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    ...existingCategory,
    id: incomingCategory.id,
    name: incomingCategory.name,
    image: incomingCategory.image || existingCategory.image || '',
    items: mergedItems,
  };
}

function mergeSeason(existingData, seasonInfo, incomingEntries) {
  const existingCategories = Array.isArray(existingData.categories)
    ? existingData.categories
    : [];

  const incomingById = new Map(
    incomingEntries.map(entry => [entry.category.id, entry])
  );

  const mergedCategories = existingCategories.map(existingCategory => {
    const incomingEntry = incomingById.get(existingCategory.id);

    if (incomingEntry) {
      return mergeCategory(existingCategory, incomingEntry);
    }

    // Even categories not returned by the source lose explicit
    // unreleased items, so stale entries cannot persist forever.
    const oldItems = Array.isArray(existingCategory.items)
      ? existingCategory.items
      : [];

    return {
      ...existingCategory,
      items: oldItems.filter(item => !isExplicitlyUnreleased(item)),
    };
  });

  const mergedIds = new Set(mergedCategories.map(category => category.id));

  for (const entry of incomingEntries) {
    if (!mergedIds.has(entry.category.id)) {
      mergedCategories.push({
        ...entry.category,
        items: entry.category.items.filter(
          item => !isExplicitlyUnreleased(item)
        ),
      });
      mergedIds.add(entry.category.id);
    }
  }

  const data = {
    ...existingData,
    version: `auto-${new Date().toISOString().slice(0, 10)}`,
    updatedAt: new Date().toISOString(),
    season: existingData.season || seasonInfo.displayName,
    categories: mergedCategories,
  };

  const changed = JSON.stringify(data) !== JSON.stringify(existingData);
  return { changed, data };
}

async function fetchSpriteCatalog() {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(SPRITES_API_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Sprite API returned HTTP ${response.status}.`);
    }

    const payload = await response.json();

    if (
      payload?.status !== 200 ||
      !Array.isArray(payload?.data) ||
      payload.data.length === 0
    ) {
      throw new Error('Sprite API returned empty or unexpected data.');
    }

    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log(`Fetching sprites from ${SPRITES_API_URL}`);

  const families = await fetchSpriteCatalog();
  const parsed = families.map(family => ({
    family,
    seasonInfo: parseSeason(family.season),
  }));

  for (const entry of parsed) {
    if (!entry.seasonInfo) {
      throw new Error(
        `Unknown season "${entry.family.season}". No files were changed.`
      );
    }
  }

  const seasonInfos = [
    ...new Map(
      parsed.map(entry => [entry.seasonInfo.id, entry.seasonInfo])
    ).values(),
  ].sort(compareSeasons);

  if (!seasonInfos.length) {
    throw new Error('No valid seasons found.');
  }

  const currentSeasonId = seasonInfos[seasonInfos.length - 1].id;
  const bySeason = new Map();

  for (const { family, seasonInfo } of parsed) {
    if (!bySeason.has(seasonInfo.id)) {
      bySeason.set(seasonInfo.id, {
        seasonInfo,
        entries: [],
      });
    }

    const entry = buildIncomingCategory(
      family,
      seasonInfo,
      seasonInfo.id === currentSeasonId
    );

    bySeason.get(seasonInfo.id).entries.push(entry);
  }

  const pendingWrites = [];
  const mergedSeasons = [];

  for (const { seasonInfo, entries } of bySeason.values()) {
    const existing = getExistingSeasonData(seasonInfo);
    const merged = mergeSeason(existing.data, seasonInfo, entries);

    mergedSeasons.push({
      seasonInfo,
      data: merged.data,
    });

    if (merged.changed || !existing.exists) {
      pendingWrites.push({
        filePath: existing.filePath,
        data: merged.data,
      });
    }
  }

  const latest = mergedSeasons.sort(
    (a, b) => compareSeasons(a.seasonInfo, b.seasonInfo)
  ).at(-1);

  if (latest) {
    const currentPath = path.join(DATA_DIR, CURRENT_SEASON_FILENAME);
    const currentData = fs.existsSync(currentPath)
      ? loadJson(currentPath)
      : null;

    if (
      !currentData ||
      JSON.stringify(currentData) !== JSON.stringify(latest.data)
    ) {
      pendingWrites.push({
        filePath: currentPath,
        data: latest.data,
      });
    }
  }

  if (!pendingWrites.length) {
    console.log('No sprite changes found.');
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const file of pendingWrites) {
    fs.writeFileSync(
      file.filePath,
      `${JSON.stringify(file.data, null, 2)}\n`,
      'utf8'
    );

    console.log(`Updated ${path.basename(file.filePath)}.`);
  }

  console.log(`Finished: updated ${pendingWrites.length} file(s).`);
}

main().catch(error => {
  console.error(`Sprite update failed: ${error.message}`);
  process.exit(1);
});
