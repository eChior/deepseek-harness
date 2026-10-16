---
description: "Host Remote owner for the session-redaction status surface: the active term-list revision and source, the compiled rule counts, the replacement counter, and the local term-request queue depth."
kind: "package-reference"
---
# Redaction Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-redaction-controller` publishes the session-redaction status over Typert Remote. One namespace, `redaction`, answers `status()` with the active term-list revision and where it came from, the compiled term and pattern counts, how many replacements this process has made, and how many term requests are still queued locally. The record is display-safe by construction: placeholders replace sensitive literals before they reach a prompt, so the status never describes what was rewritten, only how much. The namespace stays mounted when the provider is absent, and the call then reports a named configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves the Web client alongside `@deepseek-ai/dsh-redaction`. The entry registers the `redaction` namespace independently of the provider, and its generated descriptor enters the strict Typert registry, so a profile without the provider answers with a configuration error instead of an empty record.

The browser half reaches it as `ctx.remote.redaction.status()`. A client package must not depend on a Host package, so a settings page imports the generated `./remote` face for types only and calls through the mounted namespace.

The provider is not configurable from a client: the record is read-only, and there is no counterpart write method. Redaction runs unconditionally once the provider is mounted, so this surface never offers a switch.

-----

<a id="model-experience"></a>
## Model Experience

None, as the record this namespace publishes counts rewrites without ever carrying the text that was rewritten.

#### KV Cache effect

No direct effect; the status is read by configuration surfaces and never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- The counters are process-local and reset on restart, because the replacement map is deliberately in-memory only; a status read after a restart reports zero replacements until the first rewrite of the new process.
- The revision names the term list that is currently loaded, not the newest one published upstream; a client cannot tell from this record whether a refresh is pending.
- The queue depth counts requests this machine has recorded, so it says nothing about whether another machine already reported the same term.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`status()` returns the provider's record unchanged. Projecting it field by field would be redundant here: `RedactionStatus` is a flat record of a boolean, three numbers, two strings, and an optional diagnostic string, and every one of them is already display-safe. A future provider that adds a field carrying recovered original text must stop re-exporting the record and project it instead.

</details>

**Runtime invariant:** No companion is published because the provider owns the record and this package only republishes it over the wire.
