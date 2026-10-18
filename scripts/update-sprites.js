const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SPRITES_API_URL = 'https://prod.fn-api.cc/v1/sprites';
const FORTNITE_GG_SPRITES_URL = 'https://fortnite.gg/sprites';
const REQUEST_TIMEOUT_MS = 30_000;
const CURRENT_SEASON_FILENAME = 'season-current.json';

// These are asset-only variant names that must never be published.  The API
// currently exposes "reaper" alongside real variants, even though it is not a
// player-facing variant. Keep this rule name-based so it covers every sprite,
// not only whichever sprite happened to expose it first.
const EXCLUDED_VARIANT_IDS = new Set(['reaper']);

// Every item ID that must not appear in any data file. It is extended
// automatically while the API data is processed, and rebuilt on each run.
const PURGE_ITEM_IDS = new Set();

// Variants skipped by the automatic rule during this run, for the log.
const autoExcludedLog = [];

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

// Fortnite.gg spells variant names in page URLs, while fn-api uses a mixture
// of names such as "BountyHunter" and "LootHacker". These are the canonical
// IDs used in our data files.
const FORTNITE_GG_VARIANT_PREFIXES = [
  ['bounty-hunter-', 'bountyhunter'],
  ['cheat-master-', 'cheatmaster'],
  ['cheatmaster-', 'cheatmaster'],
  ['loot-hacker-', 'hacker'],
  ['loothacker-', 'hacker'],
  ['trick-or-treat-', 'tricktreat'],
  ['tricktreat-', 'tricktreat'],
  ['holofoil-', 'holofoil'],
  ['galaxy-', 'galaxy'],
  ['gummy-', 'gummy'],
  ['candy-', 'gummy'],
  ['gold-', 'gold'],
  ['gem-', 'gem'],
  ['cube-', 'cube'],
  ['quack-', 'quack'],
];

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
function getFortniteGgImage(verifiedItemIds, itemId) {
  return verifiedItemIds.imageByItemId?.get(itemId) || '';
}

function imageForVerifiedVariant(normalImage, variantId) {
  // fn-api's CDN uses the same asset stem for a family's normal and special
  // variants. This gives Fortnite.gg-confirmed variants their own icon even
  // when fn-api omitted their record altogether.
  if (typeof normalImage !== 'string') return '';

  return normalImage.replace(
    /_variant_(?:a|base)(?=\/)/i,
    `_variant_${variantId}`
  );
}

function parseFortniteGgVariantSlug(slug) {
  for (const [prefix, variantId] of FORTNITE_GG_VARIANT_PREFIXES) {
    if (slug.startsWith(prefix)) {
      return { categoryId: slugify(slug.slice(prefix.length)), variantId };
    }
  }

  return { categoryId: slugify(slug), variantId: 'normal' };
}

async function fetchFortniteGgCatalog() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(FORTNITE_GG_SPRITES_URL, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'sprite-automation/1.0 (+https://github.com/ohad2207/sprite-automation)',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Fortnite.gg returned HTTP ${response.status}.`);
    }

   const html = await response.text();
const verifiedItemIds = new Set();
const imageByItemId = new Map();

const spriteLinks =
  /\/sprites\/\d+-([a-z0-9-]+)-sprite(?=["'/?#])/gi;

for (const match of html.matchAll(spriteLinks)) {
  const { categoryId, variantId } =
    parseFortniteGgVariantSlug(match[1]);

  if (!categoryId) continue;

  const itemId = `${categoryId}_${variantId}`;
  verifiedItemIds.add(itemId);

  const linkStart = html.lastIndexOf('<a', match.index);
  const linkEnd = html.indexOf('</a>', match.index);

  if (linkStart === -1 || linkEnd === -1) continue;

  const anchorHtml = html.slice(linkStart, linkEnd + 4);
  if (!anchorHtml.includes(match[0])) continue;

  const imageTag =
    anchorHtml.match(/<(?:img|source)\b[^>]*>/i)?.[0];

  if (!imageTag) continue;

  const imageMatch =
    imageTag.match(/\b(?:data-src|data-original|data-lazy-src)=["']([^"']+)["']/i) ||
    imageTag.match(/\bsrc=["']([^"']+)["']/i) ||
    imageTag.match(/\bsrcset=["']([^"'\s,]+)/i);

  if (!imageMatch?.[1]) continue;

  const rawImageUrl = imageMatch[1].replace(/&amp;/g, '&');

  const imageUrl = rawImageUrl.startsWith('//')
    ? `https:${rawImageUrl}`
    : new URL(rawImageUrl, 'https://fortnite.gg').href;

  if (/^https?:\/\//i.test(imageUrl)) {
    imageByItemId.set(itemId, imageUrl);
  }
}

verifiedItemIds.imageByItemId = imageByItemId;

    // A tiny or malformed page could otherwise silently delete most of the
    // catalog. Require a credible catalog plus two known current entries.
    if (
      verifiedItemIds.size < 100 ||
      !verifiedItemIds.has('honey_bountyhunter') ||
      !verifiedItemIds.has('one_wish_willow_bountyhunter')
    ) {
      throw new Error('Fortnite.gg returned an incomplete or unrecognised sprite catalog.');
    }

    return verifiedItemIds;
  } finally {
    clearTimeout(timeout);
  }
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

// AUTOMATIC RULE: a variant counts as "in the game" only if the API gives it
// some way to be obtained. A variant that has no spawn/reward/grant path and no
// row in the spawn tables is just an asset sitting in the game files that never
// shipped, which is what "reaper" is. This works for any variant name, in any
// season, with no list to maintain.
//
// It is deliberately conservative:
//  - "Cube" variants have acquisition all empty but DO have a spawn-table row,
//    so they count as real and are kept.
//  - If a record has no acquisition data at all (a different API shape),
//    there is no evidence either way, so it is kept.
//  - The normal/base variant is never judged by this rule.
function isWiredIntoGame(variant) {
  const acquisition = variant?.acquisition;
  if (!acquisition || typeof acquisition !== 'object') return true;

  const spawn = variant.spawn && typeof variant.spawn === 'object' ? variant.spawn : {};

  return Boolean(
    acquisition.spawnable ||
    acquisition.granted ||
    (Array.isArray(acquisition.methods) && acquisition.methods.length > 0) ||
    (Array.isArray(acquisition.grants) && acquisition.grants.length > 0) ||
    spawn.weightRow ||
    spawn.eventRow
  );
}

function describeAcquisition(variant) {
  const acquisition = variant?.acquisition || {};
  const spawn = variant?.spawn || {};
  return (
    `spawnable=${Boolean(acquisition.spawnable)}, granted=${Boolean(acquisition.granted)}, ` +
    `methods=${(acquisition.methods || []).length}, grants=${(acquisition.grants || []).length}, ` +
    `spawnRow=${spawn.weightRow || spawn.eventRow || 'none'}`
  );
}

function isPurgedItem(item) {
  if (!item || typeof item.id !== 'string') return false;

  // This removes previously committed Reaper entries even if the source API
  // does not return their family during the current run.
  return PURGE_ITEM_IDS.has(item.id) || /_reaper$/i.test(item.id);
}

// Removes purged items from a categories array. A category that ONLY becomes
// empty because of this removal is dropped too, so no hollow category is left.
function sanitizeCategories(categories) {
  let removed = 0;
  const cleaned = [];

  for (const category of categories) {
    if (!category || !Array.isArray(category.items)) {
      cleaned.push(category);
      continue;
    }

    const keptItems = category.items.filter(item => !isPurgedItem(item));
    removed += category.items.length - keptItems.length;

    if (category.items.length > 0 && keptItems.length === 0) continue;

    cleaned.push({ ...category, items: keptItems });
  }

  return { categories: cleaned, removed };
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

function buildIncomingCategory(family, seasonInfo, isCurrentSeason, verifiedItemIds) {
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
  const apiImagesByVariantId = new Map();

  for (const variant of rawVariants) {
    const variantInfo = getVariantInfo(variant.variant);
    const itemId = `${categoryId}_${variantInfo.id}`;
    apiImagesByVariantId.set(
      variantInfo.id,
      getImage(variant) || getImage(family) || ''
    );

    // Fortnite.gg is the published-catalog check. Never expose an API-only
    // asset (for example Reaper) that the public tracker does not list.
    if (!verifiedItemIds.has(itemId)) {
      filteredItemIds.add(itemId);
      continue;
    }

    // Asset-only variants must never be included, regardless of what
    // acquisition metadata the API happens to expose for them.
    if (EXCLUDED_VARIANT_IDS.has(variantInfo.id)) {
      PURGE_ITEM_IDS.add(itemId);
      filteredItemIds.add(itemId);
      continue;
    }

    // Automatic rule: a non-base variant the API gives no way to obtain is
    // not in the game. It is skipped now AND remembered in PURGE_ITEM_IDS so
    // it is also removed from anything saved in earlier runs.
    if (variantInfo.id !== 'normal' && !isWiredIntoGame(variant)) {
      PURGE_ITEM_IDS.add(itemId);
      filteredItemIds.add(itemId);
      autoExcludedLog.push(
        `${itemId} (${seasonInfo.id}) - ${describeAcquisition(variant)}`
      );
      continue;
    }

    if (seenIds.has(itemId)) {
      throw new Error(
        `Duplicate source ID "${itemId}" in ${seasonInfo.id}.`
      );
    }
    seenIds.add(itemId);

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
      image:
        getImage(variant) ||
        getImage(family) ||
        getFortniteGgImage(verifiedItemIds, itemId),
    };

    if (typeof variant.released === 'boolean') {
      item.released = variant.released;
    } else if (typeof variant.isReleased === 'boolean') {
      item.released = variant.isReleased;
    }

    items.push(item);
  }

  // fn-api can lag behind the public catalog. Add a Fortnite.gg-confirmed
  // variant missing from the API for an existing family (for example Bounty
  // Hunter Honey and One Wish Willow), while keeping fn-api as the source for
  // season membership and the family itself.
  const prefix = `${categoryId}_`;
  const normalImage = apiImagesByVariantId.get('normal') || getImage(family) || '';
  for (const verifiedItemId of verifiedItemIds) {
    if (!verifiedItemId.startsWith(prefix) || seenIds.has(verifiedItemId)) continue;

    const variantId = verifiedItemId.slice(prefix.length);
    if (variantId === 'normal' || EXCLUDED_VARIANT_IDS.has(variantId)) continue;

    const variantInfo = Object.values(VARIANT_ALIASES).find(
      alias => alias.id === variantId
    ) || { id: variantId, label: humanize(variantId) };

    items.push({
      id: verifiedItemId,
      name: variantInfo.label ? `${categoryName} ${variantInfo.label}` : categoryName,
     image:
       getFortniteGgImage(verifiedItemIds, verifiedItemId) ||
       imageForVerifiedVariant(normalImage, variantId) ||
       normalImage,
    });
    seenIds.add(verifiedItemId);
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

  // Remove filtered IDs, purged items, and items already marked unreleased.
  const mergedItems = existingItems.filter(item =>
    !filteredIds.has(item.id) &&
    !isExplicitlyUnreleased(item) &&
    !isPurgedItem(item)
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
  // Sanitize first: strips purged items and drops any category that ends up
  // empty only because of that, instead of leaving a hollow one.
  const existingCategories = Array.isArray(existingData.categories)
    ? sanitizeCategories(existingData.categories).categories
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
    // unreleased items and purged items, so stale entries
    // cannot persist forever.
    const oldItems = Array.isArray(existingCategory.items)
      ? existingCategory.items
      : [];

    return {
      ...existingCategory,
      items: oldItems.filter(item =>
        !isExplicitlyUnreleased(item) &&
        !isPurgedItem(item)
      ),
    };
  }).filter(category => category.items.length > 0);

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

  // Fetch and validate before the API data is processed or any local file can
  // be written. A Fortnite.gg outage is intentionally a failed run, so the
  // next scheduled run retries without publishing unverified data.
  const verifiedItemIds = await fetchFortniteGgCatalog();
  console.log(`Verified ${verifiedItemIds.size} public sprite variant(s) from Fortnite.gg.`);

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
      seasonInfo.id === currentSeasonId,
      verifiedItemIds
    );

    // Do not create a category when all of its variants were filtered out.
    if (entry.category.items.length > 0) {
      bySeason.get(seasonInfo.id).entries.push(entry);
    }
  }

  // All incoming data is processed, so PURGE_ITEM_IDS is complete before
  // anything is merged or written.
  if (autoExcludedLog.length > 0) {
    console.log(
      `Skipped ${autoExcludedLog.length} variant(s) the API gives no way to obtain:`
    );
    for (const line of autoExcludedLog) console.log(`  - ${line}`);
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

  // Safety net, part 1: strip purged items from every file about to be written.
  let purged = 0;
  for (const file of pendingWrites) {
    const cleaned = sanitizeCategories(file.data.categories);
    if (cleaned.removed > 0) {
      purged += cleaned.removed;
      file.data = { ...file.data, categories: cleaned.categories };
    }
  }

  // Safety net, part 2: other data files the merge didn't touch (for example
  // an older file the API no longer returns) are cleaned too, so a variant
  // that is not in the game can't keep living in a file the app still reads.
  const handledPaths = new Set(
    pendingWrites.map(file => path.resolve(file.filePath))
  );

  if (fs.existsSync(DATA_DIR)) {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.endsWith('.json')) continue;

      const filePath = path.join(DATA_DIR, name);
      if (handledPaths.has(path.resolve(filePath))) continue;

      let data;
      try {
        data = loadJson(filePath);
      } catch {
        continue; // not a file we understand; leave it alone
      }

      if (!data || !Array.isArray(data.categories)) continue;

      const cleaned = sanitizeCategories(data.categories);
      if (cleaned.removed > 0) {
        purged += cleaned.removed;
        pendingWrites.push({
          filePath,
          data: { ...data, categories: cleaned.categories },
        });
      }
    }
  }

  if (purged > 0) {
    console.log(`Removed ${purged} previously saved item(s) that are not in the game.`);
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
