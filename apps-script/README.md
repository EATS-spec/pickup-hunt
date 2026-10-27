# Five-minute cloud relay

This standalone Google Apps Script timer calls the deployed Site. It runs on Google's servers while the Mac and browser are off. Each callback offers one turn to Pickup Hunt's shared queue; the existing four-minute request gate, backoff, and queue fairness still apply. More distinct searches increase the time between checks of any one search.

## Install

1. In the intended Google account, create a standalone Apps Script project named **Pickup Hunt cloud timer**. Copy `Code.gs` into its code editor. In Project Settings, enable the manifest file and use `appsscript.json` from this directory.
2. In Project Settings → Script Properties, set `PICKUP_HUNT_SITE_ORIGIN` to **your own** deployed HTTPS origin (for example, `https://my-pickup.example`), without a path, query, or fragment. Generate a random callback credential. Store its SHA-256 digest as the Site environment secret `CALLBACK_TOKEN_HASH`. Store the original value only in Script Properties as `PICKUP_HUNT_CALLBACK_TOKEN`.
3. Deploy the Site environment change. Run `setupPickupHunt` in the script editor and complete Google's authorization for external requests and managing this script's triggers. This grants no Gmail, Drive, Contacts, or Calendar access.
4. Read the execution result. Setup verifies a fresh persisted Site heartbeat before installing the five-minute trigger. Run `pickupHuntTimerStatus` to confirm exactly one timer.
5. After the timer has actually been installed, set the Site's `SCHEDULE_CADENCE_MINUTES` to `5` and deploy. Keep the existing hourly Sites task as a fallback. The Site may correctly warn about delayed checks if the faster relay stops.
6. After an unattended run, `pickupHuntTimerStatus` must show a fresh `lastScheduledSuccessAt`, and Site health must show a new `lastTickAt`. A successful setup/manual call alone does not prove unattended execution.

Secrets must never appear in source, logs, screenshots, task prompts, or repository history. There is no default deployment target: setup fails before sending a request until the origin property is configured. Redirects are disabled so the callback credential cannot follow a redirect to another origin. Configure a separate origin and callback credential for each installation; do not target the public demo.

## Operations

- `refreshPickupHunt`: run once manually through the same callback as the timer.
- `pickupHuntTimerStatus`: print safe timing/outcome metadata and own timer count.
- `stopPickupHuntTimer`: delete this script's Pickup Hunt timer only. It does not stop users' saved watches; the hourly fallback can still serve them.
- `setupPickupHunt`: safely reinstall. A failed callback or trigger creation preserves an existing timer. An overlap is skipped locally and the hosted request gate also protects concurrent callers.

Apps Script timing is approximate and quota limited. This relay is not a promise of a five-minute scan of every search or immediate notification delivery.

Official references: [installable time-driven triggers](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers), [ClockTriggerBuilder](https://developers.google.com/apps-script/reference/script/clock-trigger-builder).
