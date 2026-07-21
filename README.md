# RACESIDE

Historical form intelligence for UK & Irish racing. Search any trainer, jockey, owner, sire, dam, damsire or horse and pull their full historical record — strike rates, A/E and level-stake P/L — sliced by course, distance, going, class, code, region and date range.

Data: The Racing API analysis endpoints (Standard plan or above).

## Stack

- `index.html` — the whole app, no build step
- `api/tra.js` — Vercel serverless proxy (holds Racing API credentials, whitelists paths, edge-caches responses for 1h)

## Deploy (phone-friendly)

1. **GitHub** → New repository → name it `raceside` (private is fine) → create.
2. Add the three files (`index.html`, `api/tra.js`, `README.md`) via *Add file → Upload files* or *Create new file* (for `api/tra.js` type `api/tra.js` as the filename to create the folder).
3. **Vercel** → Add New → Project → import `raceside` → Framework preset: *Other* → Deploy.
4. Project → Settings → Environment Variables → add:
   - `RACING_API_USERNAME` — your Racing API username
   - `RACING_API_PASSWORD` — your Racing API password
   (same values as prizerun/racing1 — copy them across)
5. Deployments → ⋯ → Redeploy (env vars only reach functions on a fresh deploy).

Open the site, pick TRAINERS, type a name, tap FIND.

## Sanity check

Visit `/api/tra?path=/v1/trainers/search&name=appleby` on your deployment:

- JSON with search results → working
- `{"ok":false,"error":"no-credentials"}` → env vars not saved or no redeploy yet
- 401/403 from upstream → wrong credentials or plan doesn't cover the endpoint

## Notes

- Analysis endpoints are **Standard plan**. Raw per-entity `/results` history is **Pro** — the proxy already whitelists those paths, so the app can grow into them without changes.
- Edge caching (1h) keeps you well inside the API rate limit even if you hammer it.
- Distance filters are entered in furlongs and converted to yards (×220) for the API.
