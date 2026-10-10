# dsh-opencode-live-models

English | [中文](README.zh-CN.md)

DeepSeek Harness (DSH) ships with a pi-ai model catalog that can lag behind
OpenCode Go. This plugin updates it at runtime, and keeps the gateway's two
per-request requirements — a session header and a usable prompt-cache retention —
in place for the models it manages.

## Install

**Desktop** — open **Plugins** in the sidebar, click **Add plugin**, paste the spec, then choose **Enable now** and restart DSH:

```
github:Luca4Don3/dsh-opencode-live-models
```

**CLI** — `add` both installs and selects the bundle; restart DSH to compose it:

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-opencode-live-models
```

The `github:` spec downloads over HTTPS from codeload.github.com; an npm mirror does not proxy it, so the host needs reachable GitHub access.

Requires DSH 0.1.5-rc.1 or newer, and **0.3.0 or newer of this plugin**.

> **0.3.0 drops the bundled model descriptors.** A model the installed catalog
> does not carry is now offered only while Pi's catalog is reachable, so a first
> boot with no network lists one model less than 0.2.1 did: `space-bunny-free`.
> See [How it works](#how-it-works).

> **0.1.1 is kept for the record — do not install it.** Two defects are fixed in
> 0.1.2: a roster that arrives before the adapter registers can pass the size
> guard and hide installed models, and unloading leaves the overlay installed, so
> the picker keeps showing models the plugin is no longer maintaining. Upgrading
> in place is enough; existing installs do not need to be removed first.

## How it works

- Loads model descriptors from [Pi's catalog](https://pi.dev/api/models/providers/opencode-go?types=chat).
  **Nothing is bundled**: the overlay is whatever Pi currently publishes, so an
  id added, renamed or retired upstream needs no release here. The installed
  catalog remains available if the fetch fails.
- Checks the [OpenCode Go model list](https://opencode.ai/zen/go/v1/models) for
  retired **installed** models and reports model IDs that lack descriptors.

Pi's own entries are exempt from that check. A model Pi still publishes while OCG
has retired it stays in the picker until Pi drops it — following Pi's cadence is
this plugin's contract, and treating a gateway gap as a retirement would retire
exactly the ids Pi is ahead on.

The plugin updates pi-ai's `opencode-go` model list, and rewrites two things on
the way to the wire. Requests continue through the installed pi-ai transport and
authentication.

**Session headers, on every opencode route.** OpenCode Go refuses a request that
arrives without `x-opencode-session` (`400 MissingSessionID`) and asks a client to
identify itself rather than look like a generic SDK — while pi-ai puts *pi's* user
agent on every route. pi-ai's own injection covers its two built-in provider
descriptors and nothing else, so this plugin wraps the `Models` prototype and
supplies `x-opencode-session` (from the session id) plus `x-opencode-client: dsh`
for any model whose provider is `opencode`/`opencode-go` or whose base URL is on
`opencode.ai`. The prototype is the right layer for two reasons: a route added for
a custom id — the same gateway under a different name — is invisible to the
built-in injection, and the `Models` collection is rebuilt whenever profiles
change while the class behind it is not. A header already configured on the
request options or on the model descriptor always wins.

**Why the cache option.** `cacheRetention` is the only switch DSH exposes for the
two wire fields that keep the gateway's prefix cache alive — `prompt_cache_key`
and `prompt_cache_retention: "24h"`. pi-ai defaults it to `"short"`, which sends
neither, so a turn is only ever served from the gateway's own roughly five-minute
automatic window; a direct DeepSeek endpoint keeps its disk cache for hours to
days. That is why the same session reports a lower cache-hit rate through
`opencode-go` than against the official API. The setting is a *provider-level*
pi-ai field with no per-model form, so left alone it would reach every model on
the route; `/^deepseek/i` names the ones this plugin changes. `kimi-k2.6` is the
single model upstream that already opts out through
`compat.supportsLongCacheRetention`, and no model on the route declares
`cacheControlFormat`, so the ids matching the pattern are exactly the ones whose
behaviour changes. The overlay's `stream` / `streamSimple` forward to the original
provider with that option merged in, leaving transport, auth and provider-level
headers untouched.

Both feeds are fetched in parallel and neither is trusted to shrink the catalog:
a response that is empty, malformed, or implausibly smaller than the last good
one is refused rather than applied, so a bad fetch cannot quietly empty the
picker.

Mounting does not wait for them. The installed catalog is already a correct
catalog — the one you would have had without this plugin — so it is published
the moment the plugin loads; the network refresh runs behind that and publishes
again only if it changes something. On a first boot with no network at all, that
floor plus the on-disk cache is everything the plugin has to offer, which is the
deliberate cost of bundling nothing.

The accepted catalog is also written to disk and read back on the next start,
so an outage does not cost you the models only Pi carries. It goes to the
profile directory when DSH exposes one, otherwise to `~/.dsh`. Cached entries
are re-validated on the way in, a cache older than a week is ignored, and one
that cannot be written or read is simply skipped. Pi serves an ETag, so an
unchanged catalog costs a conditional request rather than a full body.

**Reading the log.** On a `304` the plugin keeps both the catalog and the ETag
and does not rewrite the file, so the cache's mtime staying put is the expected
result, not a failure. `catalog updated` marks a change in the *visible* catalog
and nothing else — restoring the cache at start can produce it too, and its
absence says nothing about whether the refresh worked. A first `catalog
published` count is not a fixed number either.

What to check after a controlled restart: the overlay was installed, a `catalog
published` appeared, and no `pi.dev catalog refresh failed` did — **but wait for
the first refresh to finish before looking for that warning.** The two requests
run in parallel with an 8s timeout each, and the failure is only recorded once
both settle, so the absence of a warning right after `catalog published` means
nothing yet. Allow the timeout window before concluding anything.

## Test

```sh
npm test
```

Runs `probe.mjs` against fixtures committed in `test/fixtures/`, captured from
the live endpoints — no network or setup needed after a fresh clone.

## Probe

Two of the three fixtures are the endpoints' own response bodies, verbatim:

```sh
curl -sS https://opencode.ai/zen/go/v1/models \
  -o test/fixtures/ocg-models.json
curl -sS 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  -o test/fixtures/pi-dev-opencode-go.json
```

The third is the catalog the installed pi-ai ships, which lives inside the
desktop client rather than on disk:
`app.asar` → `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`.
`docs/catalog-injection.md` has a working reader for that archive. Record the
pi-ai version it came from in **both** the filename (`opencode-go-<version>.json`)
and `CATALOG_SOURCE` in `probe.mjs` — the assertions that cite it are statements
about a catalog that exists only inside one release, and a fixture that silently
stops matching the client is how this suite once passed against something nobody
was shipping.

Then run the suite. Most counts are derived from the fixtures rather than written
down, so a genuine upstream change should leave it green. What must not change
silently is the set of models the drift report names — if that differs, the
answer to "which live models have no descriptor" moved with it, so read
`docs/protocol-probing.md` before editing any assertion that names a model.

To try fixtures without committing them:

```sh
OCG_FIXTURES=/path/to/fixtures npm test
```

## Limitations

- Models without descriptors do not appear in the picker.
- The two endpoints, the five-minute poll interval and the cache age are fixed in
  the source. The gateway base URLs are fixed **on purpose** — a remote catalog
  decides which models exist, never where a request goes — so pointing this at a
  different gateway means editing `lib/index.js`.
- The long cache retention is hard-coded to model ids matching `/^deepseek/i` in
  `lib/index.js`. Every other model on the route keeps pi-ai's default, and there
  is no config flag — widen the pattern there if you want a different set.
- The session-header wrapper is installed on the `Models` prototype, so it is
  offered to every provider the process registers, not only opencode's. The
  `opencode.ai` host check is what keeps every other route untouched — and it is
  also why the wrapper is not limited to the ids this plugin manages.
- The plugin uses `llm-pi-ai` internals. If a DSH update changes them, it logs a
  warning and leaves the installed catalog in place.

## License

MIT
