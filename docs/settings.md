---
repo: 0000-chat/0000-factory
status: current
---

# Settings and data roots

The tracker engine accepts a versioned settings JSON file and a data-only
repository as separate inputs. Every build supplies these four explicit
paths:

~~~text
--engine-root ENGINE --data-root DATA --settings SETTINGS_JSON --out OUTPUT
~~~

ENGINE is this repository. DATA is an external checkout or directory whose
layout is selected by the settings file. SETTINGS_JSON must be inside DATA,
and OUTPUT must be a separate directory. The engine rejects data roots nested
inside the engine and rejects output paths that overlap an input.

The settings schema covers branding, repository layout, browser namespaces,
approval protocol, Access mode, publishing mode, and deployment metadata. A
public example uses access.kind set to unconfigured and publish.kind set to
disabled. These modes do not request provider credentials or make external
publish calls. Ready Access and enabled publishing are test-only settings
created by the synthetic fixture tests.

## Root layout

Copy examples/root to an external data directory. Its settings file is at the
data root:

~~~sh
ENGINE=/path/to/0000-factory
DATA=/path/to/external-root-data
SETTINGS=$DATA/settings.json
OUT=/path/to/external-root-output

node $ENGINE/tooling/tracker/cli.mjs build \
  --engine-root $ENGINE --data-root $DATA \
  --settings $SETTINGS --out $OUT
bun $ENGINE/tracker/viewer/tooling/build.mjs \
  --engine-root $ENGINE --data-root $DATA \
  --settings $SETTINGS --out $OUT
~~~

## Nested layout

Copy examples/nested to an external data directory. Its settings, asset, and
canonical tracker files are under the literal tooling/project-tracker folder:

~~~sh
ENGINE=/path/to/0000-factory
DATA=/path/to/external-nested-data
SETTINGS=$DATA/tooling/project-tracker/settings.json
OUT=/path/to/external-nested-output

node $ENGINE/tooling/tracker/cli.mjs build \
  --engine-root $ENGINE --data-root $DATA \
  --settings $SETTINGS --out $OUT
bun $ENGINE/tracker/viewer/tooling/build.mjs \
  --engine-root $ENGINE --data-root $DATA \
  --settings $SETTINGS --out $OUT
~~~

The viewer build writes generated browser assets, a data snapshot, generated
Worker entry/configuration, and non-served provenance files under OUTPUT.
Settings and source records remain in DATA.

## Synthetic fixture helper

Use tests/helpers/fixture-data.mjs when authoring test data. It writes only
synthetic settings, assets, and canonical records and returns their exact
paths. The command wrapper provides disposable forms:

~~~sh
node tests/helpers/fixture-command.mjs --help
~~~

Its supported commands are tracker-build, tracker-check, tracker-validate,
tracker-archive, viewer-build, and viewer-dev. The direct entrypoint help
forms are:

~~~sh
node tooling/tracker/cli.mjs --help
bun tracker/viewer/tooling/build.mjs --help
~~~

Never point these commands at a private checkout. Keep all generated output
and temporary fixture roots outside the engine.
