# TEAM projection browser proof

Build a populated and an empty `team-projection-v1` output with the existing
viewer build, serve each output with the existing `createDevHandler`, then run:

```sh
TEAM_POPULATED_URL=http://127.0.0.1:4311 \
TEAM_EMPTY_URL=http://127.0.0.1:4312 \
TEAM_SCREENSHOT_DIR=/tmp/team-ui-browser-run/screenshots \
TEAM_BROWSER_EXECUTABLE=/path/to/chromium \
TEAM_BROWSER_PROFILE=/tmp/team-ui-browser-run/chrome-profile \
TEAM_BROWSER_FALLBACK=1 \
bun tests/tracker-browser/team-projection-validation.mjs
```

`TEAM_BROWSER_FALLBACK=1` is useful on Chromium builds where LiveStore's
SharedWorker or OPFS implementation is unavailable; it keeps the same served
viewer and uses the adapter's documented single-tab/in-memory fallback.
The script checks task browsing, person filtering, read-only task details,
private route redirects, the shared weekly archive, empty states, and page
errors. Screenshots are written to `TEAM_SCREENSHOT_DIR`.
