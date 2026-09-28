# dsh-opencode-live-models

English | [中文](README.zh-CN.md)

`dsh-opencode-live-models` is a DeepSeek Harness (DSH) plugin that keeps the
OpenCode Go model catalog current without waiting for a pi-ai or DSH release.

It patches **one thing**: the `getModels()` of the `opencode-go` provider inside
the running pi-ai `Models` collection. Every other part of dispatch — the wire
transports, auth resolution, provider headers — keeps working exactly as the
installed pi-ai does it, which is why a model the old pi-ai has never heard of
still routes correctly.

## Why this exists

The `opencode-go.json` catalog ships inside pi-ai and is generated at package
time. It does not track the gateway. Measured against the installed desktop
client (`dsh 0.1.7-rc.2`, pi-ai `0.85.1`) on 2026-09-28:

| Source | Models |
|---|---|
| Installed pi-ai catalog | 27 |
| `https://pi.dev/api/models/providers/opencode-go?types=chat` | 29 |
| `https://opencode.ai/zen/go/v1/models` (live) | 43 |

16 models the gateway serves had no descriptor in the installed catalog,
including `space-bunny-free` and `deepseek-v4.1-flash`.

## How it patches

DSH's `llm-pi-ai` adapter builds a pi-ai `Models` collection per operation and
reads every catalog fact from it:

- `listModels()` → `snapshot.models.getModels(provider)`
- `resolveModel()` → `snapshot.models.getModel(provider, id)`
- dispatch → `snapshot.models.streamSimple(model, ...)`

In pi-ai, `getModel(provider, id)` is `getModels(provider).find(m => m.id === id)`,
and `setProvider()` swaps a provider at runtime. So wrapping the `opencode-go`
provider's `getModels()` reaches the model picker, capability resolution, and
dispatch **without reimplementing a transport**.

The plugin hooks `PiAiAdapter.current()`, which memoizes one snapshot and rebuilds
it on every configuration change, so the overlay survives a settings edit.

## Zero imports, on purpose

This module imports nothing at runtime. A profile's `node_modules` cannot resolve
the DSH packages, because they live inside `app.asar` in the installed desktop
client:

```
$ node -e "require('module').createRequire('~/.dsh/profiles/desktop/x.js').resolve('@deepseek-ai/dsh-web')"
MODULE_NOT_FOUND
```

Any `import '@deepseek-ai/dsh-llm'` therefore fails in the installed client. The
plugin instead reaches the running pi-ai instance through `ctx.llm.adapters` — a
TypeScript-`private` field that is an ordinary `Map` at runtime. This is the same
path `dsh-opencode-session` uses, and it is why this plugin installs where a
plugin with dsh imports does not.

## Data sources, in priority order

1. **Pi's catalog** — `https://pi.dev/api/models/providers/opencode-go?types=chat`
   returns complete descriptors (api, baseUrl, capacities, compat,
   thinkingLevelMap). Authoritative and pre-verified.
2. **`FALLBACK_MODELS`** — descriptors for `deepseek-v4.1-flash` and
   `space-bunny-free`, used when the remote catalog is unreachable.
3. **The installed catalog**, untouched, so a model Pi has not published is never
   dropped just because a fetch was partial.

The live roster from `https://opencode.ai/zen/go/v1/models` is used for **drift
reporting only**. A name with no descriptor is reported, never guessed: `/models`
returns an id and nothing else, and guessing `api` or `contextWindow` would fail
mid-turn instead of at load.

### Why the overlay is not filtered by the roster

A model is removed from the picker only when it is in the *installed* catalog and
absent from the roster. Overlay entries are exempt: a roster fetch that fails or
lags must not empty the catalog, and a model Pi still publishes while the
gateway has not yet indexed it is a rollout lag, not a retirement.

## Ordering

Appending the overlay to the installed catalog would read as two blocks — the
installed order, then every new model piled on the end — because `Map.set`
never moves an existing key, so the overlay can only append. The roster is
therefore ordered deliberately:

- **Spine:** the order Pi's catalog publishes, which is authoritative and
  version-aware. A model the gateway added lands on the spine with everyone
  else instead of in a trailing block.
- **Anchored insertions:** the models only the installed catalog carries
  (`omen-alpha`, `qwen3.6-plus`, …) go *before* their nearest following spine
  model, so a family stays together: `glm-5.1` is placed before `glm-5.2`, not
  after it.
- **Tail:** anything with no anchor goes last.

With Pi's catalog unreachable there is no spine to follow, so the installed
order is returned untouched rather than guessed at.

## Install

In the DSH plugin page, or:

```sh
dsh plugin --profile desktop add dsh-opencode-live-models
```

Requires `dsh >= 0.1.5-rc.1` (`dsh.engines.dsh`).

## Expected log

```
opencode-live-models: installed live catalog overlay on opencode-go
opencode-live-models: loaded 29 model descriptors from pi.dev
opencode-live-models: OpenCode Go currently exposes 43 models
opencode-live-models: 14 live model(s) have no descriptor yet and are NOT added: ...
```

The last line is normal: those models have no descriptor anywhere yet. They are
reported, not added. To adopt one, add it to the Pi catalog or to
`FALLBACK_MODELS` with its `api`, `baseUrl`, `contextWindow` and `maxTokens`.

## Probe

`probe.mjs` verifies the merge logic against captured real responses: both
fallback models land in the catalog with complete descriptors, the installed
catalog is never emptied, undescribed models are never added, the two upstream
outages degrade without clearing the picker, and the ordering above holds —
including a first boot with no Pi catalog, which must fall back to the
installed order.

```sh
# Capture fixtures (needs network)
mkdir -p ../.temp/ocg-fixtures
curl -s https://opencode.ai/zen/go/v1/models > ../.temp/ocg-fixtures/ocg-models.json
curl -s 'https://pi.dev/api/models/providers/opencode-go?types=chat' \
  > ../.temp/ocg-fixtures/pi-dev-opencode-go.json
# opencode-go-0.85.1.json comes from the installed client's app.asar

node probe.mjs          # 26/26
```

Override the fixture directory with `OCG_FIXTURES`.

## Known limitations

- **Only descriptors that already exist are added.** A model OCG deploys before
  Pi publishes it stays absent until someone supplies a descriptor. Closing that
  gap needs a protocol probe, which this plugin deliberately does not guess at.
- **Hooking a TypeScript-`private` field** (`ctx.llm.adapters`, `adapter.current`)
  couples the plugin to llm-pi-ai's internals. A release that renames them logs
  a warning and leaves the catalog alone — it fails visibly, not silently.
- **No replay state**, no `developer` role, no deferred tool loading: all
  unchanged from the underlying `llm-pi-ai`, which this plugin does not replace.

## License

MIT
