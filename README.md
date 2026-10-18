# Sprite Automation

A GitHub Actions-driven repo that fetches the Fortnite sprite catalog from
`https://prod.fn-api.cc/v1/sprites` and updates the season data files used by
the Fortnite Sprite Tracker app.

## How it works

```
sprite-automation/
  .github/workflows/update-sprites.yml   <- schedule + steps
  scripts/update-sprites.js              <- catalog fetcher and validator
  data/c<chapter>s<season>.json          <- one catalog per season
  data/season-current.json               <- copy of the latest season
  package.json
```

1. GitHub runs the workflow on a schedule (daily at 06:00 UTC by default).
2. It runs the catalog update script with Node.js 20.
3. Before changing data, the script validates Fortnite.gg's public Sprite
   catalog. `fn-api.cc` entries must appear there to be included; entries
   visible on Fortnite.gg but temporarily missing from the API are added.
4. If Fortnite.gg cannot be fetched or its catalog is incomplete, the run
   fails without changing files. The next daily run retries automatically.
5. Variants explicitly marked unreleased are excluded. Asset-only `reaper`
   variants are also always excluded and removed from older saved files.
6. If a file changed, the workflow commits and pushes it back into this
   repo automatically.

## If the catalog update fails

If a workflow run fails:

1. Check the run's logs first (Actions tab → the failed run → expand the
   "Run the sprite-update script" step) — the error message will usually
   make it obvious whether it's a block vs. something else.
2. Confirm the API still returns a `status: 200` response with a non-empty
   `data` array.
3. Check whether the API changed its season or variant fields, then update
   the normalisation in `scripts/update-sprites.js` if needed.

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

## Data shape written to each season file

```json
{
  "version": "auto-2026-10-18",
  "updatedAt": "2026-10-18T06:00:00.000Z",
  "categories": [
    {
      "id": "jonesy",
      "name": "Jonesy",
      "image": "https://cdn.fn-api.cc/sprites/jonesysprite_variant_a/largeicon.png",
      "items": [
        { "id": "jonesy_normal", "name": "Jonesy", "image": "..." },
        { "id": "jonesy_gold", "name": "Jonesy Gold", "image": "..." }
      ]
    }
  ]
}
```

`season-current.json` has the same structure as the newest season file.
