# dsh-opencode-live-models

English | [中文](README.zh-CN.md)

DeepSeek Harness (DSH) ships with a pi-ai model catalog that can lag behind
OpenCode Go. This plugin updates it at runtime.

## Install

Add it from the DSH plugin page, or run:

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-opencode-live-models
```

Requires DSH 0.1.5-rc.1 or newer, and **0.1.2 or newer of this plugin**.

> **0.1.1 is kept for the record — do not install it.** Two defects are fixed in
> 0.1.2: a roster that arrives before the adapter registers can pass the size
> guard and hide installed models, and unloading leaves the overlay installed, so
> the picker keeps showing models the plugin is no longer maintaining. Upgrading
> in place is enough; existing installs do not need to be removed first.

## How it works

- Loads model descriptors from [Pi's catalog](https://pi.dev/api/models/providers/opencode-go?types=chat).
  The installed catalog remains available if the fetch fails.
- Includes fallback descriptors for `deepseek-v4.1-flash` and `space-bunny-free`
  when Pi's catalog is unavailable.
- Checks the [OpenCode Go model list](https://opencode.ai/zen/go/v1/models) for
  retired installed models and reports model IDs that lack descriptors.

The plugin updates pi-ai's `opencode-go` model list. Requests continue through
the installed pi-ai transport and authentication.

Both feeds are fetched in parallel and neither is trusted to shrink the catalog:
a response that is empty, malformed, or implausibly smaller than the last good
one is refused rather than applied, so a bad fetch cannot quietly empty the
picker.

Mounting does not wait for them. The installed catalog plus the bundled
fallbacks is already a correct catalog, so it is published the moment the plugin
loads; the network refresh runs behind that and publishes again only if it
changes something.

The accepted catalog is also written to the profile directory and read back on
the next start, so an outage does not cost you the models only Pi carries.
Cached entries are re-validated on the way in, a cache older than a week is
ignored, and one that cannot be written or read is simply skipped. Pi serves an
ETag, so an unchanged catalog costs a conditional request rather than a full
body.

## Test

```sh
npm test
```

Runs `probe.mjs` against fixtures committed in `test/fixtures/`, captured from
the live endpoints — no network or setup needed after a fresh clone.

## Limitations

- Models without descriptors do not appear in the picker.
- The plugin uses `llm-pi-ai` internals. If a DSH update changes them, it logs a
  warning and leaves the installed catalog in place.

## License

MIT
