---
description: "Redaction settings tab for the dsh web client: the term-list revision and source, the compiled rule counts, this process's replacement counter, the staff directory, and the department term lists a user uploads to this machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-redaction

English | [中文](README.zh.md)

## Summary

The **Redaction status** tab reports the session guard and takes each department's own term list. It shows the loaded revision and its source, how many terms and patterns compiled, how many replacements this process made, and how many term requests still wait. Below that, a department adds a list in the publisher's format, sees what it declares, and turns it on or off. The guard itself has no off switch, so that half explains rather than configures. Loading, failure, and retry states are handled, and a blocked list or a refresh that kept the loaded rules says why.

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

The status half carries no control beyond that refresh. The provider has no off switch by design, so every prompt and every tool result passes the term list before it reaches the session; this part of the page exists to make that guard observable, not adjustable.

### What each row means

**Term list revision** is the revision the loaded list declares, or a dash when nothing loaded. **Term list source** names the copy the compiled rules came from — shipped with the client, the local cache, or the intranet publisher. **Compiled rules** counts the terms and the patterns separately, because a term matches literally while a pattern compiles as a JavaScript subset. **Replacements in this process** counts matches the provider has rewritten since the Host started, which includes every prompt and every tool result that carried a term. **Queued term requests** counts terms waiting on this machine for a delivery target. **Last publisher check** shows when the provider last asked the publisher, and reads as never before the first attempt.

Two notes appear only when they apply. A blocked term list names the reason nothing is being replaced — an unreadable file, an unparsable list, or a compile failure. A refresh that kept the rules already loaded names why, so a stale revision is visible rather than silent.

### Uploading a department term list

The upload half is the one writable part of the page. **Download the example** saves the commented file this build ships, so a department edits the real shape instead of a paraphrase; the same content is what `example()` returns over the wire.

**Choose a file** reads the chosen file in the browser and sends its text, so what arrives is the YAML its author can already read. Nothing is written before the provider accepts it, and a file the provider refuses leaves the machine unchanged. The page holds the same 256 KB ceiling the provider does and rejects a larger file without sending it.

An upload arrives stamped with the department and author the staff directory reports for the signed-in account, and a file that already carries its own `department:` or `author:` line keeps it. Each entry lists its name, that attribution, whether it is in force, and how many terms and patterns it contributes; **Remove** drops it and **In force**/**Off** toggles it without touching what the file declares.

A file that cannot take part is still listed, with each problem on its own line naming the file's line number. That is deliberate: the upload stays visible so its author can see what is wrong, rather than disappearing into a rejected request.

A line above the list reports whether colleague and department names from the staff directory are being redacted, and how many names that covers. When no directory is loaded, the page says so rather than implying an upload will be filed under a department.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tab is a projection in two directions: the status half holds one view-state snapshot and reads the Host on mount and on refresh, while the upload half reads the machine's files, mutates through Remote, and re-reads.

### Registration

The browser plugin registers one localized `settings.plugins.tab` contribution with id `redaction` and order `20`, so it follows the Plugin list tab. Registration uses `ctx.slots.inject()`, which follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

### Reading and writing the status

`inject` returns one callback per Remote method. Each awaits `ctx.remote.redaction.<method>()` and unwraps the result: a refused call is thrown, so the component renders the shared failure state instead of a partial record. The initial read happens in an effect with a liveness guard, so a response that arrives after unmount is discarded.

Every mutation re-reads through `uploads()` rather than trusting the reply, and then asks the page above to refresh its status, because a newly enabled list changes the compiled rule count. A mutation that fails sets the banner and leaves the list as the Host last reported it.

### Why the view type is declared on the Host

The Host controller declares `RedactionStatusView` in its own `./types` subpath rather than re-exporting the provider's `RedactionStatus`. The analyzer behind the Remote boundary walks the declarations of a public type subpath, and a subpath that only re-exports another module leaves it without a declaration of its own. The client imports that view type-only, so the browser bundle carries no Host code.

### Why the upload reads the file in the browser

The file picker hands its text to `upload({ name, text })`, and there is no Host-side path that accepts an opaque blob. The provider measures every uploaded pattern against a sample prompt before it accepts the file, which is a decision it can only make on text it already has, and a rejected upload therefore never reaches a disk it would have to be cleaned off later.

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

None, as the tab only reads the status of a guard the provider already runs over every prompt and tool result, and the lists it uploads are compiled by that same provider before any model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the page can show; they are current package constraints.

- **One snapshot per mount or refresh** — the tab does not subscribe to provider changes, so the counters move only when the user refreshes, and another session's replacements appear in the same process-wide total.
- **The page edits uploaded lists only** — the published term list has no editor here, because a rule that over-matches is corrected where the list is published so the fix reaches every machine on its own refresh.
- **An upload stays on this machine** — the page has no way to hand a list to a colleague or a team; a department that has to cover every seat distributes the file itself.
- **Replacing a file is an upload, not an edit** — there is no in-place editor, so changing one term means editing the YAML and choosing the file again under the same name.
- **The list is read once per reload** — the page does not watch the upload directory, so a file placed there by hand appears only after a refresh or a remount.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a Settings contribution that reads and mutates the `redaction` namespace.
