---
description: "Host Remote owner for the session-redaction surface: the active term-list revision and source, the compiled rule counts, the replacement counter, the local term-request queue depth, the staff directory, and the department term lists a user uploads."
kind: "package-reference"
---
# Redaction Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-redaction-controller` publishes the session-redaction surface over Typert Remote. One namespace, `redaction`, answers `status()` with the loaded term-list revision, its source, the compiled term and pattern counts, this process's replacement count, and the queued term requests; `roster()` reports the staff directory; `uploads()`, `upload()`, `drop()`, `setEnabled()` and `example()` manage this machine's department term lists. Every reply is display-safe by construction: a status says how much was rewritten, never what, and an upload is the file its own author wrote. The namespace stays mounted without the provider and then reports a named configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves the Web client alongside `@deepseek-ai/dsh-redaction`. The entry registers the `redaction` namespace independently of the provider, and its generated descriptor enters the strict Typert registry, so a profile without the provider answers with a configuration error instead of an empty record.

The browser half reaches it as `ctx.remote.redaction.<method>()`. A client package must not depend on a Host package, so a settings page imports the generated `./remote` face for types only and calls through the mounted namespace.

### What each method answers

`status()` reads the provider unchanged. `roster()` adds what the staff directory says about the signed-in colleague, so an upload can be filed under a department and an author without the caller naming either. Nobody signed in, or an account service that cannot answer, yields `null` for the account rather than a failure — the upload is still worth taking, it simply carries no department.

`uploads()` lists what this machine holds, including a file whose text does not compile: its author is the one who has to see what is wrong. `upload({ name, text })` stamps the file with the caller's attribution, stores it, and puts it in force. `remove({ name })` is published as `drop({ name })` — it drops one — and `setEnabled({ name, enabled })` turns one on or off without touching what it declares. `example()` hands back the commented example this build ships, so a department starts from the real shape rather than a paraphrase.

### Attribution comes from the directory, never from the payload

The caller cannot claim a department through the method's own arguments. `upload()` resolves the signed-in name through the provider's `identify()` and stamps the directory's answer onto the file; a name the directory does not list gets the author alone, and a department is never guessed. The stamp is inserted only when the file does not already carry that line — a department that wrote its own `department:` or `author:` header keeps it, so a hand-maintained list is not silently rewritten, and a caller still cannot set either through the wire.

The provider is not configurable from a client: there is no method that edits the published term list, and redaction runs unconditionally once the provider is mounted, so this surface never offers a switch for the guard itself. The switches here act on uploaded lists only, which already sit on top of the published one.

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
- Uploads live on the machine that took them. A department that has to cover every seat distributes the file itself; nothing here fans one upload out to a team.
- Attribution follows the signed-in account and the staff directory, so the same upload from a shared login, or from a colleague the directory does not list, arrives with no department to file it under.
- Nothing cancels an upload that a published term already covers, and nothing reports whether a department's rule duplicated, preceded, or shadowed one from the published list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`status()` projects the provider record field by field instead of re-exporting it, because the browser half imports the type across the Remote boundary and a subpath that only re-exports another module leaves the analyzer without a declaration to walk. Projecting also keeps this namespace's own `RedactionStatusView` free to stop carrying a field the provider might later add — a field that recovered original text could never be republished here.

`roster()` is the only method that reads another service: it resolves the signed-in display name through `deepseekAccount`, then asks the provider what the staff directory says. Every failure along that path — nobody signed in, a provider that throws, a name the directory does not list — collapses to `null`, because a missing department must never turn into a refused upload.

The drop endpoint is named `drop`, not `remove`, and renaming it back breaks the whole Web client. The Browser face installs each endpoint as a member of the namespace's generated service, and refuses the ones whose names collide with that service's own methods — `remove`, `has`, `empty`, `install`, `ctx`, `methods`, `name`, `namespace`. That refusal is not a failed call but a refused mount: the client assembly aborts while booting, leaving every namespace unavailable. `removeLocal()` on the provider keeps its own name; only the wire name differs.

</details>

**Runtime invariant:** No companion is published because the provider owns the record and this package only republishes it over the wire.
