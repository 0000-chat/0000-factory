# Factory control repository instructions

Factory is the canonical generic tracker engine and viewer. Keep instance
data, settings, identities, and deployment credentials in each consumer
repository.

## Shared tracker releases

When a change is intended for the shared tracker surface, publish it through
the `codex/weekly-planning-archive` release channel. Consumer repositories
follow the immutable manifest in `releases/current.json` and their own pinned
lock. This `main` branch remains the standalone Factory implementation; a
shared-tracker change is complete only after both consumer receipts and the
joined `release-receipts/<release-id>/complete.json` receipt verify the same
Factory revision and both live consumer runtimes report it.

Read [`docs/settings.md`](docs/settings.md) for the Factory configuration
boundary before changing settings or release validation.
