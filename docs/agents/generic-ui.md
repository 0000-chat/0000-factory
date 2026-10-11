# Generic UI source contract

Factory owns the reusable tracker surface: the browser application under
`tracker/viewer`, the instance renderer and settings validator under
`tooling/instance`, and the Access and publishing Worker under `worker`.
These paths are the default generic UI source for every supported instance.

An instance build selects Factory explicitly:

```sh
bun tooling/tracker/cli.mjs validate-only \
  --engine-root /path/to/factory \
  --data-root /path/to/instance-data \
  --settings /path/to/instance-data/settings.json
bun tracker/viewer/tooling/build.mjs \
  --engine-root /path/to/factory \
  --data-root /path/to/instance-data \
  --settings /path/to/instance-data/settings.json \
  --out /path/to/output \
  --engine-commit <full-factory-sha>
```

The settings file is the only supported instance customization boundary. A
consumer may overlay a runtime secret binding in a generated Worker entry,
provided the Factory Worker remains the request and authorization path. The
generic build must not discover or import a local consumer UI through an old
`--source` flag or an implicit current-working-directory fallback.

Tracker migration metadata remains instance-neutral: a legacy approval may
reference any loaded decision, while the core validator still requires that
decision to be approved by a recognized Don identity and to affect the retained
item. The settings model may provide an instance-scoped `approverIds` alias
list; when omitted, the generic `don` and `owner` aliases apply. Do not
hard-code a fixture's decision ID or a consumer's private approver handle into
the generic engine.

Release automation pins a full Factory commit, rejects a dirty checkout, and
checks the generated Wrangler route, disabled `workers.dev` and preview URLs,
and `ASSETS` binding before deployment. Changes to the generic UI require the
Factory tests and a consumer build against the pinned revision.
