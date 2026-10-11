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
approval protocol, optional viewer features, Access mode, publishing mode, and
deployment metadata. `features.weeklyPlanning` is optional and defaults to
`true`; set it to `false` to remove the weekly planning view and archive from
one instance. A
public example uses access.kind set to unconfigured and publish.kind set to
disabled. These modes do not request provider credentials or make external
publish calls. Ready Access and enabled publishing are test-only settings
created by the synthetic fixture tests.

Ready Access settings may authorize individual identities with
`access.readerEmails` and may additionally authorize mailbox domains with the
optional `access.readerEmailDomains` array. Each configured domain is a
lowercase-normalized public DNS name and is matched against the complete email
domain from the signed Access identity; `@example.test` does not authorize a
subdomain. At least one exact email or domain is required, and both arrays are
bounded. A GitHub-app publisher still must be listed in `readerEmails`, so a
domain-only policy remains read-only. The Worker applies this policy only
after issuer, audience, time, and signature verification. The identity provider
and its Google-only policy are configured outside this Factory settings file.

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

## Team projection layout

An instance that is intended to read a shared team projection sets its data
layout and projection path explicitly:

```json
{
  "data": {
    "folderPath": "",
    "layout": "team-projection-v1",
    "projectionPath": "projection/current.json",
    "evidence": { "kind": "none" },
    "projectionLinkPolicy": {
      "allowedEvidenceHosts": [],
      "forbiddenGitHubRepositories": []
    }
  },
  "publish": { "kind": "disabled" }
}
```

`projectionPath` is a safe repository-relative path below the selected
`folderPath`. Factory reads that one JSON file and validates the schema-1 team
projection contract. It accepts the original `team-projection` weekly shape
and the `standing-team-projection` shape emitted by the team delivery mirror.
The standing shape exposes only its public task fields (`title`,
`description`, `assignee`, `reviewer`, `status`, `nextStep`,
`completionCriteria`, and the explicitly labeled `approved` or `forecast`
`deadline`). Factory derives its display week from the export timestamp. Its
`gaps`, `audit`, and disabled `publish` metadata are validated at the input
boundary and omitted from browser data. Team mode does not load canonical tracker records,
evidence sources, or private history. Access may be
unconfigured or ready with a disabled service; publishing must remain disabled.
The generated browser payload uses the existing tracker snapshot shape with
only public projection tasks populated. Canonical approvals, receipts, and
Don controls are not created by this adapter. The build derives a blocked,
read-only team presentation from the same allowed task fields; it does not
copy a private weekly HTML file or add current-draft or approval controls. The
presentation is marked `presentationKind: "team-projection"` and reports
coverage as partial because a projection is not a canonical weekly plan.
Evidence links must be query-free HTTPS URLs without credentials and must use
an explicitly configured `data.projectionLinkPolicy.allowedEvidenceHosts`
entry. The optional `forbiddenGitHubRepositories` list uses lowercase
`owner/repository` values to deny private source paths even when `github.com`
is an allowed host. With no link policy, all projection evidence links are
rejected; loopback, local-network, and IP hosts remain rejected globally.
Narrative fields may contain ordinary product terms such as Slack, meetings,
OAuth, and tokens; credential-shaped values and narrative URLs remain invalid,
so public links belong in `evidenceLinks`.
An empty projection with the all-zero source plan digest is treated as an
uninitialized setup state: it produces a working empty app and no stale weekly
episode. A non-empty projection must carry a real source plan digest.

For tracker-v1, weekly planning archives remain optional, validated
presentation inputs kept separate from the canonical tracker snapshot. See
[the archive contract](planning-archive.md) for the generic schema, validation
boundary, and route behavior.

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
