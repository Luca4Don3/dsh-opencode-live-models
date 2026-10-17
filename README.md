# dsh-opencode-live-models

English | [中文](README.zh-CN.md)

DeepSeek Harness (DSH) ships with a pi-ai model catalog that can lag behind
OpenCode Go, OpenCode Zen and native OpenAI Codex. This plugin updates all three
at runtime and keeps OpenCode's session headers and prompt-cache retention in
place. It also provides ChatGPT sign-in on its plugin detail page and read-only
OpenAI / OpenCode Go subscription usage and OpenCode Zen monetary balances in **Settings → Account & balance**.
Codex retains its native transport and OAuth.

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

> **0.11.3 clears resolved startup catalog diagnostics.** When a complete live descriptor repairs a saved model's missing API, both its runtime diagnostic and the Models settings error are updated; unresolved models and unrelated configuration errors remain visible.
>
> **0.11.2 fixes model deselection.** Apply selection and save after unchecking a model to remove an existing catalog entry; discovery no longer only adds rows.
>
> **0.11.0 adds official OpenCode Console sign-in.** Authorize a workspace from this plugin's detail page. Zen billing prefers that workspace login, while model API keys keep their existing purpose. HTTP 403 is no longer presented as proof of missing key permissions.
>
> **0.10.2 centers the startup loading view.** “Loading settings…” appears beneath the native DeepSeek Harness logo in the center of the window.
>
> **0.10.1 clarifies Zen balance permissions.** Both legacy and Console keys are supported, denied access links to Console, and incomplete responses preserve cached money.
>
> **0.10.0 adds bounded compaction recovery.** Long histories are summarized in capacity-aware batches; transient summary failures retry once. Cancellation and failure preserve the original history.
>
> **0.9.0 integrates native Settings → Models → Fetch available models and saved model selection for API-key and OAuth routes, and adds full-width OpenCode Zen balance rows.**
>
> **0.8.0 combines model catalog updates, ChatGPT login and subscription usage in one plugin.** Login lives on the plugin detail page; subscription balances appear below the official balance in account settings. Disable the former `dsh-subscription-usage` bundle when upgrading; existing host credentials remain in use.
>
> **0.7.0 adds native OpenAI Codex catalog updates**, including `gpt-6.1-sol`, using the existing validation, ETag, cache and lifecycle mechanisms. Codex keeps its native OAuth and transport and receives no OpenCode headers or cache-option overrides.
>
> **0.6.0 aborts in-flight catalog requests on unload, fixes a new provider registered mid-refresh being dropped to the next poll, and guards the late-refresh callback against a cross-generation HMR takeover.** Catalog merging and gateway behavior are unchanged; the probe suite now runs the quota-parser regressions in CI as well.
>
> **0.5.0 covers `opencode` (OpenCode Zen) as well as `opencode-go`.** The Zen
> route used to keep whatever catalog the installed pi-ai shipped with; it is now
> refreshed from its own Pi catalog and its own live roster, with its own protocol
> table. Both routes stay independent: one gateway's outage or refused payload
> never touches the other's catalog.

> **0.3.0 drops the bundled model descriptors.** A model the installed catalog
> does not carry is now offered only while Pi's catalog is reachable, so a first
> boot with no network lists one model less than 0.2.1 did: `space-bunny-free`.
> See [How it works](#how-it-works).

> **0.1.1 is kept for the record — do not install it.** Two defects are fixed in
> 0.1.2: a roster that arrives before the adapter registers can pass the size
> guard and hide installed models, and unloading leaves the overlay installed, so
> the picker keeps showing models the plugin is no longer maintaining. Upgrading
> in place is enough; existing installs do not need to be removed first.

## Login and subscription usage

Open **Plugins** in the sidebar, then **dsh-opencode-live-models**. Its detail
page contains **Sign in with ChatGPT**, re-login, authorization status, callback
paste fallback and cancellation.

Open **Settings → Account & balance** to see subscription balances below the
official DeepSeek balance. Only subscriptions with configured credentials are
queried and displayed, with at most three providers and no duplicate DeepSeek card.
OpenAI and OpenCode Go percentage cards appear first, followed by full-width
OpenCode Zen monetary balance rows at the bottom. They load on entry and offer
**Refresh usage**, showing remaining quota percentages and reset times rather
than converting them to money. Missing data stays unknown; stale results retain
their original timestamp. This is separate from the catalog's background refresh.

Successful card results are saved locally and survive completely quitting DSH
with **Command+Q**. Startup and reopening immediately show the previous balances
while checking local credentials in the background. The first visit after startup
refreshes upstream data while retaining those cards; only providers without a
saved result show a loading placeholder. During the same run, `freshMs` (five
minutes by default) controls freshness. Expired results stay visible while each
card refreshes independently. Failed checks or queries preserve the previous
result and timestamp; confirmed logout or an account / Go-key switch removes the
old cache. Storage failures are visible and do not block online queries.
**Refresh usage** forces a new query.

The native `openai-codex` provider must already be configured in DSH's
`llm-pi-ai` providers. Go uses the existing `OPENCODE_GO_API_KEY` credential
reference; Zen uses `OPENCODE_API_KEY`. This plugin delegates login and token refresh to the host and never
implements OAuth or stores a separate credential.

When upgrading from the standalone subscription plugin, disable its bundle
before enabling this version to avoid duplicate services. Existing credentials
at `llm-pi-ai/openai-codex` and the `subscriptionUsage` service API are preserved.
The old plugin files can remain installed while disabled.

Optional configuration on the `opencode-live-models` entry:

```yaml
config:
  freshMs: 300000
  timeoutMs: 15000
  goApiKeyRef: OPENCODE_GO_API_KEY
  zenApiKeyRef: OPENCODE_API_KEY
```

Open this plugin's sidebar detail page and click **登录 OpenCode Console**. The
official device authorization page asks you to choose and approve a workspace;
choose the workspace belonging to your Zen key. Once DSH shows signed in, refresh
Zen in **Settings → Account & balance**. Billing prefers the Console workspace
login and falls back to an API key only when no Console grant exists. An expired
grant never silently switches to another key or workspace.

The documented device flow and refresh use only
`https://opencode.ai/console/auth/device/*`. The host credential service stores an
independent `dsh-opencode-live-models/opencode-console` grant; model API keys and
Codex OAuth are not overwritten. Balance caches are scoped by workspace digest.
Refresh tokens are single-use: a durable claim precedes the request, and an
ambiguous failure or crash requires sign-in rather than replaying the token.
Disabling the plugin cancels pending device authorization and billing requests.

Zen reads the Console web UI's `GET https://opencode.ai/console/api/billing/status`
endpoint and converts valid `availableMicroCents` at 100,000,000 per USD. Prepaid funds
are labeled balance; invoiced workspaces show available credit. The adapter accepts
both legacy `sk-…` and current `oc_sk_…` formats, but API-key access to this web
billing endpoint is not guaranteed. A live All key returned 200 from the public
config API and 403 from billing, including with its official workspace header.
The signed-in Console user must also have billing access to the chosen workspace.
HTTP 403 therefore means endpoint access was denied, not proof of missing key
permissions. Adding `billing:read` or All cannot be promised to resolve it.
Service-account keys are under
**Settings → Service accounts → the matching account**; personal keys are under
the top-right account menu, **Account → Personal API keys**.
For a separate billing key, save it in the host credential store and point
`zenApiKeyRef` at its reference; this setting only affects balance queries.
Denied access links to Console. Denied or missing amounts preserve cached money
and its original timestamp, or explicitly fail when no cached amount exists.
No browser cookies are read.

Verified account IDs isolate the quota engine's caches. An account without a
verified ID, including Go's current usage response, is queried without engine
cache reuse. The separate display cache uses stable scope digests for the current
Codex account / Go or Zen key and persists through the DSH page's `localStorage`. Only
rendered card fields and scope digests are saved, never raw credentials or
upstream account identifiers.

## Compaction recovery

The plugin decorates the native `compaction.summarize()` hook for manual and
automatic compaction. Short histories keep the original summarizer. Larger
histories use the host token meter to form batches of at most about 96,000
history tokens, reserving capacity for system prompts, tools, directives and
output. The native summary route, exact-target policies and output cap remain
in force; every batch and reduction uses that same provider and model.

Tool calls and their results remain together. Oversized text-only tool groups
become quoted fragments with roles and call IDs; oversized non-text groups fail
explicitly if they cannot be split safely. Ordered partial checkpoints are
consolidated before the native transaction writes one replacement checkpoint.
Failures and cancellation never replace history with partial results.

Transient transport, timeout and service failures retry once per request. A
persistent failure or confirmed context overflow halves a sufficiently large
batch. A compaction has at most 64 auxiliary requests and bounded reduction
depth. Authentication, quota and truncated-output failures remain failures.
Batches incur additional provider requests; final usage aggregates successful
summary calls. Persistent network or upstream outages still propagate as errors.

Disable/HMR restores the original hook and cancels pending recovery calls. Host
installation files and existing session files need no migration. Restart after
upgrading, then run compaction again to use the recovery path.

## Model selection

Use **Settings → Models → Fetch available models**, check the models to display,
click **应用选择 (Apply selection)**, then save the provider. Existing rows start
checked; unchecking removes them instead of retaining them in an add-only merge.
Inherited catalogs start fully checked. Custom names, capacities and input types
are retained, as are manual rows absent from discovery. Filtered select-all only
affects visible results. Removing and saving a row hides that
model from the chat dropdown, including after background refresh. API-key and
OAuth routes use the same native editor. Go, Zen and Codex discovery and native
save validation use the plugin's complete live descriptors; other providers
retain native discovery.

An absent or empty custom model catalog inherits every available model, matching
the host's reset behavior. With a custom catalog, new upstream models remain
available to fetch but enter the dropdown only after adoption. Disabling the
plugin restores its runtime catalog changes without editing host files or the
user's model configuration.

## How it works

All three configured catalogs refresh on startup and every five minutes. New
models and capability changes are published to the existing picker without
reinstalling the plugin. Network failures retain the last usable catalog and
retry on the next cycle. Models require complete descriptors and supported
protocols; skipped entries produce explicit warnings.

Compatibility limit: DSH's bundled pi-ai 0.87.1 OpenCode Go provider has no
Google transport, so the newly published `gemini-4-argon-contributor` Go entry
remains unavailable until that transport is supported. Existing Google models
on OpenCode Zen are unaffected.

- Loads model descriptors from Pi's catalog, one URL per route:
  [`opencode-go`](https://pi.dev/api/models/providers/opencode-go?types=chat),
  [`opencode`](https://pi.dev/api/models/providers/opencode?types=chat), and
  [`openai-codex`](https://pi.dev/api/models/providers/openai-codex?types=chat).
  **Nothing is bundled**: each overlay is whatever Pi currently publishes, so an
  id added, renamed or retired upstream needs no release here. The installed
  catalog remains available if the fetch fails.
- Checks each gateway's live list — [OpenCode
  Go](https://opencode.ai/zen/go/v1/models) and [OpenCode
  Zen](https://opencode.ai/zen/v1/models) — for retired **installed** models, and
  reports model IDs that lack descriptors.
- Refuses to publish entries that are catalog rows but not conversation models.
  Pi lists OpenCode Zen's two `type: "classifier"` rows beside the chat models;
  they carry no `maxTokens` and are named once and skipped rather than offered in
  the picker.

Pi's own entries are exempt from that check. A model Pi still publishes while OCG
has retired it stays in the picker until Pi drops it — following Pi's cadence is
this plugin's contract, and treating a gateway gap as a retirement would retire
exactly the ids Pi is ahead on.

The plugin updates pi-ai's `opencode-go`, `opencode` and `openai-codex` model
lists. OpenCode requests receive the two rewrites described below; every route
continues through its installed pi-ai transport and authentication.

**Native Codex.** New entries such as `gpt-6.1-sol` come from Pi's public Codex
catalog using `openai-codex-responses`, with the endpoint fixed to
`https://chatgpt.com/backend-api`. There is no authenticated roster request,
OpenCode header injection, or cache-option override on this route. Every
installed Codex model is retained. Configure `openai-codex` in DSH's native
`llm-pi-ai` providers first; this plugin does not register a new LLM route or
implement its own OAuth protocol. The merged subscription module provides
the ChatGPT login button in this plugin's detail page. Catalog refresh changes the
picker; actual model access remains subject to the account's permissions.

**Two routes, not two names for one.** They are different endpoints:
`opencode-go` sends Anthropic, OpenAI-completions and OpenAI-responses traffic to
`/zen/go`, while `opencode` is OpenCode Zen and carries a fourth protocol
(Google's) to `/zen`, from a different Anthropic root. Each route has its own
protocol table, its own catalog and its own cache entry, and only the routes DSH
actually registered are polled — a route configured nowhere is not fetched every
five minutes.

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

Each route's accepted catalog is also written to disk and read back on the next start, so an outage does not cost you the models only Pi carries. All catalogs share one file keyed by provider id — a single atomic rename keeps them consistent — and each entry is age-checked on its own, so a route that stopped being refreshed is not kept alive by another that keeps succeeding. It goes to the profile directory when DSH exposes one, otherwise to ~/.dsh. Cached entries are re-validated on the way in, a cache entry older than a week is ignored, and one that cannot be written or read is simply skipped. Pi serves an ETag per route, so an unchanged catalog costs a conditional request rather than a full body.

**Reading the log.** On a `304` the plugin keeps both the catalog and the ETag
and does not rewrite the file, so the cache's mtime staying put is the expected
result, not a failure. `catalog updated` marks a change in the *visible* catalog
and nothing else — restoring the cache at start can produce it too, and its
absence says nothing about whether the refresh worked. A first `catalog
published` count is not a fixed number either. Each route logs its own label
(`OpenCode Go` / `OpenCode Zen` / `OpenAI Codex`), so a warning names its route.

What to check after a controlled restart: the overlay was installed, a `catalog
published` appeared, and no `catalog refresh failed` did — **but wait for
the first refresh to finish before looking for that warning.** The two requests
run in parallel with an 8s timeout each, and the failure is only recorded once
both settle, so the absence of a warning right after `catalog published` means
nothing yet. Allow the timeout window before concluding anything.

## Test

```sh
npm test
```

Runs `probe.mjs` and the regressions under `test/`, including model selection,
compaction, subscriptions, quota parsing and the client UI. These tests exercise
the production modules. The older standalone parser in `docs/validation/` is
historical evidence and is excluded from CI. All tests use committed fixtures —
no network, credentials or setup needed after a fresh clone.

CI runs the suite on Node 18 (the supported minimum) and Node 24 (the DSH runtime).

## Probe

The catalogs and OpenCode rosters are captured from the live endpoints, verbatim:

```sh
curl -sS https://opencode.ai/zen/go/v1/models -o test/fixtures/ocg-models.json
curl -sS https://opencode.ai/zen/v1/models -o test/fixtures/zen-models.json
curl -sS 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  -o test/fixtures/pi-dev-opencode-go.json
curl -sS 'https://pi.dev/api/models/providers/opencode?types=chat' \
  -o test/fixtures/pi-dev-opencode.json
curl -sS 'https://pi.dev/api/models/providers/openai-codex?types=chat' \
  -o test/fixtures/pi-dev-openai-codex.json
```

The other three fixtures are the catalogs the installed pi-ai ships, which live
inside the desktop client rather than on disk:
`app.asar` → `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`
plus `.../data/opencode.json` and `.../data/openai-codex.json`.
`docs/catalog-injection.md` has a working reader for that archive. Record the
pi-ai version it came from in **both** the filename (`opencode-go-<version>.json`,
`opencode-<version>.json`, `openai-codex-<version>.json`) and `CATALOG_SOURCE` in `probe.mjs` — the assertions
that cite it are statements about a catalog that exists only inside one release,
and a fixture that silently stops matching the client is how this suite once
passed against something nobody was shipping.

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
- The endpoints each route polls, the five-minute poll interval and the cache age are fixed in
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
