---
description: "Replace sensitive identifiers and figures with stable placeholders while a prompt is still awaiting admission, before any caller can append it to a session."
kind: "package-reference"
---

# @deepseek-ai/dsh-redaction

English | [中文](README.zh.md)

## Summary

A session keeps what it is given, so redacting at the model boundary is too late: the harness appends a message to its durable log the moment it accepts one. This provider rewrites the prompt text while it is still an admission result. Every match of the configured term list becomes a stable placeholder in the form `[<label>-<n>]`, the same value always maps to the same placeholder, and the caller hands the rewritten content onward. The correspondence lives in memory only, so nothing written to disk can be turned back into the value it replaced.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin, then call `redact()` on the parts a consumer is about to turn into a message:

```yaml
- id: redaction
  name: '@deepseek-ai/dsh-redaction'
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set to `false` to leave every message exactly as typed. |
| `termsPath` | the `assets/terms.yaml` inside this package | Term list this build carries; used when the cache holds nothing usable, or holds something older. |
| `remote` | the published term-list repository on the intranet Gitea | Archive URL the cache refreshes from; an empty string turns every network call off. |
| `branch` | `main` | Branch to pull the archive from. |
| `file` | `terms.yaml` | File to read inside that archive. |
| `cacheDirectory` | `$DSH_HOME/redaction` | Where `current`, `terms-<revision>.yaml`, and `terms.fallback.yaml` live. |
| `refreshMinutes` | `5` | Minutes between background pulls; `0` disables polling and keeps the list already in hand. |
| `timeoutMs` | `3000` | Per-request timeout for one pull. |
| `vision` | `true` | Run local recognition over admitted images and substitute the redacted text. |
| `visionTimeoutMs` | `20000` | Give up on one image after this long and substitute a blocked marker. |

`redact(parts)` copies the list and rewrites only the parts whose `type` is `text`. Images, file references, and anything else come back as they arrived, so a caller can pass the result to the next stage exactly as it would have passed the input. `redactText(text)` does the same for one string held outside a part list.

Images never reach the model as pixels. This package is also the reader the attachment store calls: it recognizes the text inside an admitted image, redacts that text, and hands the text back for the image part. Nothing is written to disk, and a recognition that fails or times out substitutes a blocked marker instead of the image. A caller that admits attachments on its own can pass the reader down — `admitPromptContent(parts, ctx.get('redaction'))` — and get the same treatment for a child agent's read.

`restore(text)` swaps the placeholders this process issued back for their values. It belongs where a human reads text, never on the way into a session.

`status` reports the revision the loaded list declares, where it came from, how many terms and patterns it carries, how many replacements this process has made, and a failure detail. A term list that cannot be read leaves no rules loaded, which replaces nothing, and the reason stays visible in `status.detail` instead of failing the plugin load.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin resolves its list through `cacheDirectory`. A pointer file named `current` names the revision in use, `terms-<revision>.yaml` holds that revision's text, and `terms.fallback.yaml` keeps the last list that loaded. A pull that fails leaves the list in hand and retries later, so a machine that cannot reach the intranet keeps working with the list it already has. A list carried by this build wins over a cached one when its revision reads as a later date, so upgrading the package cannot be silently cancelled by a cache left by the previous release; revisions that do not read as dates leave the cache in place. Loading never throws: a missing file, a structural problem, or a pattern that does not compile leaves the rule set empty and writes the reason into `status.detail`, so a deployment that ships a broken list keeps working with redaction off and a visible cause.

Each `terms.yaml` entry is either a term — matched literally, escaped before it becomes a regular expression — or a pattern, compiled as written. One piece of text routinely matches several rules at once, so hits are reduced to a non-overlapping set before anything is written: longest match first, then category priority (`identifier` outranks a person's name), then leftmost. A run of digits inside a longer identifier therefore never produces a second placeholder.

Placeholder identity lives in `RedactionMap`, not in the matching code. The first sighting of a value allocates the next sequence number for its category, and later sightings of the same value reuse that placeholder — so a model reading a tool result or a later turn can follow `[编号-3]` as one thing without ever seeing what it stands for. The map is deliberately not persisted: a placeholder survives in a session file forever, while the mapping that could reverse it does not survive the process.

The reader for the list is a small scanner rather than a general YAML dependency. The format is a flat subset — top-level scalars, one list of categories, two string lists each — and the scanner is the whole of it.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the prompt text a consumer hands to `redact()`: the model sees the placeholders this provider issued in place of the values, and every other model-facing decision belongs to the consumer that called it.

#### KV Cache effect

Replacing a value with a placeholder changes the bytes of the request, so the first redacted prompt of a session cannot reuse a prefix cached before it. Within a session the prefix stays stable, because the same value always yields the same placeholder.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

**Runtime invariant:** No runtime invariant companion is published because the service owns one rule list, one status record, and one in-memory map, and no second observation of those values can diverge from the first.

- **Wiring belongs to each consumer** — this package rewrites the text a caller hands it. Prompt admission, tool results, and image attachments each need their own caller before a session is covered end to end, and none of them is wired here yet.
- **Placeholders do not survive the process** — the map is memory-only, so a restart cannot restore a placeholder an earlier process issued, and the session keeps the placeholder.
- **Container formats stay opaque** — a scan sees a workbook, a slide deck, or a PDF as compressed bytes rather than text, so those files have to be unpacked before their contents can be matched.
- **The term list is maintained outside this repository** — this package carries one copy for a build to start from; the maintained list is distributed separately and replaces it at runtime.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
