# Weekly planning archive

The viewer can display immutable, already-rendered weekly planning episodes
from the selected data repository. The optional archive is rooted at
`planning/index.json`; each index entry points to a bounded `manifest.json`,
`plan.json`, and `presentation.html` under `planning/weeks/<week>/<revision>/`.

The archive contract is schema version `1`. Weeks use ISO `YYYY-Www` values;
statuses are `draft`, `approved`, `superseded`, or `blocked`. Core-generated
manifests bind the week, revision, immutable artifact paths, and `sha256:`
digests for the plan and presentation. The loader rejects traversal, absolute,
encoded, symlinked, executable, or out-of-root artifacts, mismatched digests,
duplicate revisions, and active or externally navigable HTML. Missing
`planning/index.json` is an explicit empty archive; malformed present data
fails the build and browser archive boundary with a clear error.

Factory reads this archive separately from the canonical tracker snapshot. The
build writes the validated browser projection to `assets/planning/archive.json`
alongside the other public assets. The `/weekly-planning` route renders saved
HTML in an empty sandboxed iframe with a restrictive CSP and keeps planning
episodes read-only; canonical Plans and Work routes remain separate.

Use the normal explicit engine boundary for a private instance, replacing the
placeholders with paths owned by that instance:

```sh
bun tracker/viewer/tooling/build.mjs \
  --engine-root /path/to/0000-factory \
  --data-root /path/to/data \
  --settings /path/to/data/settings.json \
  --out /path/to/output
```

Archive data is optional synthetic or site-owned input. It is never imported
as executable code and no provider credentials belong in the data repository
or generated browser assets.

## Build and deployment handoff

The private orchestrator should pin the reviewed Factory engine commit, pass
its selected data root and settings file to the explicit build command above,
and publish only after inspecting the generated output manifest. A successful
build contains these reviewable files under its output root:

```text
worker-entry.mjs
wrangler.json
assets/planning/archive.json
build-manifest.json
```

`build-manifest.json` is the artifact manifest API for the handoff: it records
the output file hashes, including the worker entry, Wrangler configuration,
and planning archive. The orchestrator must verify those hashes and the
archive schema before handing the same output directory to its deployment
adapter. The adapter may then run the pinned configuration explicitly:

```sh
wrangler deploy --config "$OUT/wrangler.json"
```

Factory does not deploy, activate automation, or choose a private runtime.
When a validated draft is published, the orchestrator updates the selected
data root and performs a fresh build so the new immutable archive is bound in
the new output manifest. Keep output directories and credentials in the
private runtime boundary.
