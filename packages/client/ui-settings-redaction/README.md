---
description: "Read-only redaction status tab in Web Plugins settings for the dsh web client: the term-list revision and source, the compiled rule counts, this process's replacement counter, and the term requests still queued locally."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-redaction

English | [中文](README.zh.md)

## Summary

The **Redaction status** tab reports the session guard without offering to change it. It shows which term-list revision the Host loaded and where that copy came from, how many terms and patterns compiled, how many replacements this process has made, and how many term requests still wait locally for a delivery target. A note states that the guard has no off switch, so the tab explains rather than configures. It handles loading, failure, and retry states, names a blocked term list and its reason, and reports a refresh that kept the rules already loaded.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open the Plugins section in Settings and select the **Redaction status** tab. The tab reads no Remote during plugin activation: selecting it for the first time mounts the component, which then calls `ctx.remote.redaction.status()` through `api-remotes`. **Refresh** re-runs the same read.

The tab carries no control beyond that refresh. The provider has no off switch by design, so every prompt and every tool result passes the term list before it reaches the session; the page exists to make that guard observable, not adjustable.

### What each row means

**Term list revision** is the revision the loaded list declares, or a dash when nothing loaded. **Term list source** names the copy the compiled rules came from — shipped with the client, the local cache, or the intranet publisher. **Compiled rules** counts the terms and the patterns separately, because a term matches literally while a pattern compiles as a JavaScript subset. **Replacements in this process** counts matches the provider has rewritten since the Host started, which includes every prompt and every tool result that carried a term. **Queued term requests** counts terms waiting on this machine for a delivery target. **Last publisher check** shows when the provider last asked the publisher, and reads as never before the first attempt.

Two notes appear only when they apply. A blocked term list names the reason nothing is being replaced — an unreadable file, an unparsable list, or a compile failure. A refresh that kept the rules already loaded names why, so a stale revision is visible rather than silent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tab is a read-only projection: it holds one view-state snapshot and reads the Host on mount and on refresh.

### Registration

The browser plugin registers one localized `settings.plugins.tab` contribution with id `redaction` and order `20`, so it follows the Plugin list tab. Registration uses `ctx.slots.inject()`, which follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

### Reading the status

`inject` returns one callback, `status`, which awaits `ctx.remote.redaction.status()` and unwraps the result: a refused call is thrown, so the component renders the shared failure state instead of a partial record. The read happens in an effect with a liveness guard, so a response that arrives after unmount is discarded.

### Why the view type is declared on the Host

The Host controller declares `RedactionStatusView` in its own `./types` subpath rather than re-exporting the provider's `RedactionStatus`. The analyzer behind the Remote boundary walks the declarations of a public type subpath, and a subpath that only re-exports another module leaves it without a declaration of its own. The client imports that view type-only, so the browser bundle carries no Host code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the Remote call, and the record the page renders.

- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.plugins.tab`.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `redaction.status()`.
- [redaction-controller](../../api/redaction-controller/README.md) — the Host side republishing the provider record over the `redaction` namespace.
- [redaction](../../security/redaction/README.md) — the provider that owns the record and the term list.

-----

<a id="model-experience"></a>
## Model Experience

None, as the tab only reads the status of a guard the provider already runs over every prompt and tool result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the page can show; they are current package constraints.

- **One snapshot per mount or refresh** — the tab does not subscribe to provider changes, so the counters move only when the user refreshes, and another session's replacements appear in the same process-wide total.
- **No term editing** — the page reports queued requests but neither adds, removes, nor delivers one; submission and delivery are separate work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a read-only Settings contribution.
