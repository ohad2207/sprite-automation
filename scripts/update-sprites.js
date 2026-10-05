// scripts/update-sprites.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'data');
const SPRITES_URL = 'https://fortnite.gg/sprites';

const SEASONS = [
  { filterLabel: 'C7 S4', outFile: 'season-current.json', seasonName: 'Chapter 7 Season 4' },
  { filterLabel: 'C7 S3', outFile: 'season-previous.json', seasonName: 'Chapter 7 Season 3' },
];

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
  await page.waitForTimeout(500);
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
      await new Promise((r) => setTimeout(r, 100));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
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

async function selectSeasonFilter(page, label) {
  const targetOption = page.getByText(label, { exact: true });

  // אם הכפתור/אפשרות אינם גלויים, מנסים לפתוח את תפריט הסינון (Dropdown)
  if (!(await targetOption.first().isVisible().catch(() => false))) {
    const filterMenuButton = page.locator('.fn-filter, .dropdown, button:has-text("Season"), div:has-text("Season")');
    if (await filterMenuButton.first().isVisible().catch(() => false)) {
      await filterMenuButton.first().click();
      await page.waitForTimeout(300);
    }
  }

  // לוחצים על הפילטר המבוקש וממתינים לעדכון הרשת וה-DOM
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    targetOption.first().click(),
  ]);

  await page.waitForTimeout(1000);
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

    cat
