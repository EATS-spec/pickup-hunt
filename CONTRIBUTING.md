# Contributing to Pickup Hunt

Small improvements are welcome: clearer setup, more accessible controls, better notification handling, and reliable inventory parsing. Open an issue before a larger change so we can agree on the scope.

## Get a local copy running

Use Node.js 22.13 or newer and npm. Fork or clone this repository, then run:

```sh
npm ci
npm run db:migrate
npm run dev
```

The database is local to your checkout. No Apple account, push keys, or production credentials are needed to load the app or run the tests. Optional runtime settings are documented in [the README](README.md#deploy-your-own) and `.dev.vars.example`.

## Make the change

- Edit the page markup in `public/index.html`. Run `node scripts/sync-page.mjs` to update `app/page.tsx`; the production build also runs this sync.
- Keep browser behavior in `public/`, service logic in `lib/`, and persistence changes in new migrations under `drizzle/`.
- Use fixtures and injected clocks or transports for tests. Keep the automated suite independent of live Apple inventory, push services, and personal credentials.
- Preserve observation timestamps, stale-result labels, the shared request gate, and backoff. Faster scheduling must still go through the same queue.

The catalog starts from `lib/catalog-seed.json` and retains the last complete snapshot if discovery fails. An authenticated updater refreshes product metadata when it is at least 24 hours old; the public catalog button reloads the saved snapshot. Keep your deployment's scheduler running to maintain that metadata. Parser fixtures should use observed Apple product data and preserve native part numbers and checkout URLs rather than inventing combinations.

Before opening a pull request, run:

```sh
npm run lint
npm test
npm run build
git diff --check
```

The **Verify** workflow checks lint with zero warnings, runs the tests, and builds for production on pull requests and pushes to `main`.

## Send a useful issue or pull request

Describe the problem, the resulting behavior, and how you checked it. For an interface change, include desktop and narrow mobile screenshots. For a stock result, include its observation time and whether the app marked it stale.

Use example hunt details in screenshots. Keep environment files, credentials, push subscription endpoints, and checkout information out of issues and commits.

This repository is a public source template. Its commits do not automatically deploy the [live demo](https://pickup-hunt.dreaminpixels.chatgpt.site/). A clone needs its own database, secrets, and scheduler for unattended operation; see [the updater contract](UPDATER.md).

Contributions are covered by the repository's [MIT license](LICENSE).
