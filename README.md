# Wix Feature Request Tracker: daily updater

This repository keeps the tracker's data current. Every day a GitHub Action opens each
request's Wix Help Center page, reads its status label (Collecting votes, Planned or
Released), looks for new request articles, and saves the result to `data.json`.
The public tracker site loads `data.json` on every visit.

- Runs daily at 04:15 UTC, and on demand from the **Actions** tab ("Run workflow").
- Checks pages slowly (4 at a time, with pauses) to stay polite to the Help Center.
- If a page can't be read, its last known status is kept.
