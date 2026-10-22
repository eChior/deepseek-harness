---
description: "Replace sensitive identifiers and figures with stable placeholders while a prompt is still awaiting admission, before any caller can append it to a session."
kind: "package-reference"
---

# @deepseek-ai/dsh-redaction

English | [中文](README.zh.md)

## Summary

A session keeps what it is given, so redacting at the model boundary is too late: the harness appends a message to its durable log the moment it accepts one. This provider rewrites it while the prompt is still an admission result. Every match becomes a stable `[<label>-<n>]` placeholder, the same value always maps to the same one, and the caller passes it onward. The correspondence is kept in memory and appended to one local mapping file when a session ends, so the restore tool can put the originals back and a restart reuses the same placeholders.

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
| `termsPath` | the `assets/terms.yaml` inside this package | Term list this build carries; used when the cache holds nothing usable, or holds something older. |
| `remote` | the published term-list repository on the intranet Gitea | Archive URL the cache refreshes from; an empty string turns every network call off. |
| `branch` | `main` | Branch to pull the archive from. |
| `file` | `terms.yaml` | File to read inside that archive. |
| `cacheDirectory` | `$DSH_HOME/redaction` | Where `current`, `terms-<revision>.yaml`, and `terms.fallback.yaml` live. |
| `refreshMinutes` | `5` | Minutes between background pulls; `0` disables polling and keeps the list already in hand. |
| `timeoutMs` | `3000` | Per-request timeout for one pull. |
| `vision` | `true` | Run local recognition over admitted images and substitute the redacted text. |
| `visionTimeoutMs` | `20000` | Give up on one image after this long and substitute a blocked marker. |
| `includeRoster` | `true` | Add every colleague and department from the shipped staff directory to the rules, and let an upload inherit its department from it. |
| `rosterPath` | the `assets/roster.bin` inside this package | Ciphertext of the staff directory; the key that opens it is a CI secret written to `assets/roster.key` beside it. |

No field turns the provider off. A disabled provider writes exactly the values this feature exists to keep out of the session log, and writes them silently, so a rule that over-matches is corrected where the list is published instead — that fix reaches every machine on its own refresh, without a reinstall or an edit here.

`redact(parts)` copies the list and rewrites only the parts whose `type` is `text`. Images, file references, and anything else come back as they arrived, so a caller can pass the result to the next stage exactly as it would have passed the input. `redactText(text)` does the same for one string held outside a part list.

Images never reach the model as pixels. This package is also the reader the attachment store calls: it recognizes the text inside an admitted image, redacts that text, and hands the text back for the image part. Nothing is written to disk, and a recognition that fails or times out substitutes a blocked marker instead of the image. A caller that admits attachments on its own can pass the reader down — `admitPromptContent(parts, ctx.get('redaction'))` — and get the same treatment for a child agent's read.

`restore(text)` swaps the placeholders this process issued back for their values. It belongs where a human reads text, never on the way into a session.

`status` reports the revision the loaded list declares, where it came from, how many terms and patterns it carries, how many replacements this process has made, how many term requests are queued, how many uploaded lists are in force, how many directory names are in force, and a failure detail. A term list that cannot be read leaves no rules loaded, which replaces nothing, and the reason stays visible in `status.detail` instead of failing the plugin load.

The rules come from up to three sources, and `status` counts what each contributed. The published list is the floor. Above it sit the lists uploaded on this machine — what one department knows and the publisher does not — and the staff directory shipped as ciphertext in `assets/roster.bin`, whose colleague and department names enter the rules when `includeRoster` is on. Where two sources match the same text at the same length, the earlier source wins: an upload over the directory, and the directory over the published list. A directory that cannot be read is warned about and skipped, never fatal, and it never writes into `detail` — a machine with no key still redacts everything else.

`identify(account)` answers what the directory says about one colleague, `attributionFor(account)` reduces that to the `{ department?, author? }` an upload should carry, and `rosterSummary()` reports whether the directory is in force and how many people and departments it names. A name the directory does not list yields the author alone: the department is never guessed.

A term list can also be uploaded on the machine, in the same format, for a department to add what the published list cannot cover. `localFiles()` lists what this machine holds — including a file that does not compile, because its author is the one who has to see what is wrong — `importLocal(name, text, attribution)` stamps it with its author's department, stores it and puts it in force, `removeLocal(name)` drops it, `setLocalEnabled(name, enabled)` turns it on or off while leaving what it declares untouched, and `localExample()` hands back the commented example this build ships. Uploads live in `local/` under `cacheDirectory`, up to `MAX_LOCAL_FILES` of them, each at most `MAX_LOCAL_BYTES`, and their names are normalized into that directory so a name cannot address anything else on disk. A pattern that would cover a whole sample prompt is refused before the file is accepted: that is what stops a well-meaning edit from turning every request into one placeholder.

A term the list is missing can be asked for rather than waited on. `requestTerm(term, note)` appends it to a queue in `cacheDirectory`, and `deliverRequests(sink)` offers every queued request to a `TermRequestSink` the deployment supplies. No sink ships here, so a machine with no destination keeps its requests as `pending` instead of losing them, and every attempt settles each request as `uploaded` or `rejected` together with the sink's own reason — the queue records what happened rather than dropping the entry.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin resolves its list through `cacheDirectory`. A pointer file named `current` names the revision in use, `terms-<revision>.yaml` holds that revision's text, and `terms.fallback.yaml` keeps the last list that loaded. A pull that fails leaves the list in hand and retries later, so a machine that cannot reach the intranet keeps working with the list it already has. A list carried by this build wins over a cached one when its revision reads as a later date, so upgrading the package cannot be silently cancelled by a cache left by the previous release; revisions that do not read as dates leave the cache in place. Loading never throws: a missing file, a structural problem, or a pattern that does not compile leaves the rule set empty and writes the reason into `status.detail`, so a deployment that ships a broken list keeps working with redaction off and a visible cause.

Each `terms.yaml` entry is either a term — matched literally, escaped before it becomes a regular expression — or a pattern, compiled as written. One piece of text routinely matches several rules at once, so hits are reduced to a non-overlapping set before anything is written: longest match first, then category priority (`identifier` outranks a person's name), then leftmost. A run of digits inside a longer identifier therefore never produces a second placeholder.

Placeholder identity lives in `RedactionMap`, not in the matching code. The first sighting of a value allocates the next sequence number for its category, and later sightings of the same value reuse that placeholder — so a model reading a tool result or a later turn can follow `[编号-3]` as one thing without ever seeing what it stands for. The map is persisted to the local mappings directory when a session ends, in one file for the machine rather than one per task: a placeholder means the same value wherever it is read, so a session that has not been opened for weeks still shows its originals. The file is read back at startup, which is also what stops a fresh value from taking a number an earlier process already gave to something else.

The placeholder is only safe while the model leaves it alone, and a bracketed word reads like ordinary text to a model asked to summarise or translate. So the plugin also registers a prompt section of its own, `redaction:placeholders`, which states that a bracketed placeholder is normal text to be copied verbatim in both the reply and any summary; that a placeholder the user asks about is answered from the material at hand rather than looked up or restored; that two spellings of one family may be merged when summarising; and that the verbatim rule wins if the rules ever conflict. The instruction rides in the system prompt rather than in the settings page because the reader who needs it is the model, and it is registered unconditionally because this provider has no off switch: a session that carries a placeholder always needs the rule that keeps it intact.

The reader for the list is a small scanner rather than a general YAML dependency. The format is a flat subset — top-level scalars, one list of categories, two string lists each — and the scanner is the whole of it.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the prompt text a consumer hands to `redact()`: the model sees the placeholders this provider issued in place of the values, including a colleague or a department reduced to `[人名-2]` or `[部门-1]`, and every other model-facing decision belongs to the consumer that called it.

#### KV Cache effect

Replacing a value with a placeholder changes the bytes of the request, so the first redacted prompt of a session cannot reuse a prefix cached before it. Within a session the prefix stays stable, because the same value always yields the same placeholder.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

**Runtime invariant:** No runtime invariant companion is published because the service owns one rule list, one status record, and one in-memory map, and no second observation of those values can diverge from the first.

- **Coverage follows the callers that were wired** — this package rewrites the text a caller hands it, so prompt admission, tool results, and image attachments are covered because those callers pass through it. A path that assembles text and writes it without calling `redact()` is still uncovered, and an assistant's own reply is never rewritten.
- **A term request has no destination on its own** — the queue holds what a machine cannot deliver, and `deliverRequests` needs a sink a deployment supplies. Nothing here reaches the publisher by itself, so an install without a sink accumulates requests rather than sending them.
- **Placeholders do not survive the process** — the map is memory-only, so a restart cannot restore a placeholder an earlier process issued, and the session keeps the placeholder.
- **Container formats stay opaque** — a scan sees a workbook, a slide deck, or a PDF as compressed bytes rather than text, so those files have to be unpacked before their contents can be matched.
- **The term list is maintained outside this repository** — this package carries one copy for a build to start from; the maintained list is distributed separately and replaces it at runtime.
- **The staff directory is a build-time snapshot** — `assets/roster.bin` is sealed when the package is packed, so a colleague who joins, leaves, or changes department is only reflected by the next release. A name the directory does not list is attributed to its author alone, and a departed colleague leaves the rules only because `active` was false in that snapshot.
- **The directory key is not part of the artifact** — the ciphertext travels in the package and the key is a CI secret, so an install that skipped that step, or a build with no secret set, loads no directory at all. That is a warning, not a failure: every other source still applies.
- **An upload cannot be attributed by hand** — the department on an upload comes from the directory and the signed-in account, so a shared login or an unlisted name files the list under nobody, and there is no method that overrides it.
- **Uploads are per-machine** — the `local/` directory belongs to one install, and nothing here distributes a list to a colleague, checks whether another machine already holds the same one, or merges two uploads from the same department.
- **An upload is never reconciled with the published list** — a department rule that duplicates, precedes, or shadows a published one is compiled and counted without a note, so an upload can make a published rule unreachable for the same span without saying so.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
