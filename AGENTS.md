# Factory repository instructions

Factory is the canonical generic tracker UI and Worker source. Consumer
repositories provide a versioned instance settings file and a data root; they
must invoke the explicit build interface with `--engine-root`, `--data-root`,
`--settings`, and (for reproducible output) `--engine-commit`.

Keep instance-specific branding, data, Access audience, deployment names,
credentials, and publish policy out of this repository. The generic engine
must continue to enforce the settings contract, the human Access boundary,
service-only read behavior, and the configured publish policy for every
consumer. A consumer may provide a narrow Worker entry adapter for an
existing runtime binding, but it must not fork or replace the generic gate.

The default generic UI source is `tracker/viewer`; its Worker boundary is
`worker/access-gate.mjs`. Do not add a consumer-local UI fallback to the
Factory build or package scripts. See [docs/agents/generic-ui.md](docs/agents/generic-ui.md)
for the source and release contract.
