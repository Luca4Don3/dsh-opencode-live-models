# dsh-opencode-live-models

English | [中文](README.zh-CN.md)

DeepSeek Harness (DSH) ships with a pi-ai model catalog that can lag behind
OpenCode Go. This plugin updates it at runtime.

## Install

Add it from the DSH plugin page, or run:

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-opencode-live-models
```

Requires DSH 0.1.5-rc.1 or newer.

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
