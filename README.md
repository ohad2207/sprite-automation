# Sprite Automation

A GitHub Actions-driven repo that scrapes https://fortnite.gg/sprites on a
schedule and rebuilds `data/sprites.json`, so the Fortnite Sprite Tracker
app's catalog doesn't need to be edited by hand.

## How it works

```
sprite-automation/
  .github/workflows/update-sprites.yml   <- schedule + steps
  scripts/update-sprites.js              <- the real scraper (Playwright)
  data/sprites.json                      <- rebuilt and committed on every run
  package.json
```

1. GitHub runs the workflow on a schedule (daily at 06:00 UTC by default).
2. It installs Playwright's headless Chromium and runs the scraper.
3. The scraper opens fortnite.gg/sprites in a real (headless) browser,
   forces every lazy-loaded image to resolve, then reads every sprite entry
   straight out of the page.
4. Entries are grouped into categories (e.g. "Jonesy", "Jonesy Gold",
   "Jonesy Cheat Master" all collapse into one `jonesy` category) and
   written to `data/sprites.json` in the same shape the app already uses.
5. Unreleased sprites are included too, exactly as asked — they just get
   `"released": false` and often an empty `"image"` until fortnite.gg
   actually has art for them (the app already shows a clean fallback tile
   for any sprite with no image).
6. If the file changed, the workflow commits and pushes it back into this
   repo automatically.

## Why a real headless browser, not a simple fetch

fortnite.gg/sprites lazy-loads most of its images — the raw HTML for
anything below the fold doesn't contain a real image URL until JavaScript
fills it in. A plain HTTP request would only ever see empty placeholders
for most of the list. Playwright actually runs the page like a browser, so
the script can force everything to load before reading it.

## What the scraper relies on (and doesn't)

- **Relies on**: the URL pattern `/sprites/<id>-<slug>-sprite` (very stable
  — the ID and slug encode the sprite and its variant), and image files
  living at `/img/x/sprites/icons/*.webp`.
- **Does NOT rely on**: fortnite.gg's CSS class names or page layout, which
  weren't inspectable in detail and could change without notice. If the
  URL/slug pattern itself ever changes, the scraper would need an update —
  but that's a much rarer kind of change than a CSS redesign.

## ⚠️ If scraping gets blocked

This hasn't been tested from inside GitHub Actions' actual network yet.
fortnite.gg *is* reachable with a normal fetch, but sites like this
sometimes rate-limit or block requests coming from well-known cloud
provider IP ranges (which is what GitHub Actions runners use), even though
the same request works fine from a home connection. If the workflow starts
failing or returns 0 entries:

1. Check the run's logs first (Actions tab → the failed run → expand the
   "Run the sprite-update script" step) — the error message will usually
   make it obvious whether it's a block vs. something else.
2. If it looks like a block: try spacing runs out further (e.g. once every
   few days instead of daily), since bursty traffic is what most basic
   anti-bot rules look for.
3. Come back and tell me what the log says — the fix depends heavily on
   *how* it's being blocked (a hard IP ban looks very different from a
   JS/CAPTCHA challenge, and they need different workarounds).

## One-time setup

1. Create a new repo on GitHub and push everything in this folder into it.
2. **Settings → Actions → General → Workflow permissions** → select
   **"Read and write permissions"** (needed for the Action to push the
   commit back).
3. That's it.

## Running it

- **Automatically**: runs on the `cron:` schedule once it's on GitHub.
- **Manually** (recommended for the first test): **Actions** tab → "Update
  Sprites" → **Run workflow**.

## Data shape written to sprites.json

```json
{
  "version": "auto-2026-10-04",
  "updatedAt": "2026-10-04T06:00:00.000Z",
  "categories": [
    {
      "id": "jonesy",
      "name": "Jonesy",
      "image": "https://fortnite.gg/img/x/sprites/icons/T_Icon_BR_Creature_Sprite_Jonesy_L.webp",
      "items": [
        { "id": "jonesy_normal", "name": "Jonesy", "image": "...", "released": true },
        { "id": "jonesy_gold", "name": "Jonesy Gold", "image": "...", "released": true },
        { "id": "jonesy_cheatmaster", "name": "Jonesy Cheat Master", "image": "...", "released": true },
        { "id": "jonesy_tricktreat", "name": "Jonesy Trick or Treat", "image": "", "released": false }
      ]
    }
  ]
}
```

This is a superset of what the Electron app currently reads (it adds a
`released` field per item) — the app ignores fields it doesn't know about,
so this is safe to feed straight into a season's `sprites.json` as-is, or
you can strip `released` out if you'd rather keep the file minimal.
