---
repo: 0000-chat/0000-factory
status: current
---

# Contributing

Keep this repository focused on the reusable engine. Site settings, records,
people, team guides, migration files, deployment values, receipts, logs,
screenshots, browser reports, and credentials belong in an external data
repository and must not appear in issues, pull requests, fixtures, or commits.

Use the reviewed fixture factory in tests/helpers/fixture-data.mjs for new
synthetic data. Fixture repositories use fake branches and repositories,
reserved .test or .invalid domains and email addresses, synthetic identities,
and authored static assets. Tests that exercise Access or publishing must use
generated test keys and a fake transport; they must never call a live provider.

Before opening a change, install Node.js 26.3.1, Bun 1.3.14, and `setsid`, then
run the frozen install, browser prerequisite, privacy scan, and full local gate:

~~~sh
bun install --frozen-lockfile
bun x playwright install chromium
TMPDIR=/absolute/path/to/factory-check-cache ./scripts/check
~~~

The check script requires `setsid` to own one unique process group under TMPDIR, supplies external fixture,
metadata, and output paths to each subprocess, waits for child servers to
exit, and removes only that child. Keep new temporary paths outside the engine.

Preserve the exact dependency versions, lockfile, and three pinned LiveStore
patches. A dependency update requires review of the resolved package entries
and affected third-party license texts. Keep first-party Markdown ownership
frontmatter as repo: 0000-chat/0000-factory and status: current.

Pull requests should describe the behavior changed and the tests that cover
it. Review engine changes independently from any site data or deployment
authority. Do not add deployment, publish, provider, credential, secret
management, release, tag, or production operations to this repository or its
CI workflow.
