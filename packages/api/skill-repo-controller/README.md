---
description: "Host Remote owner for publishing local skills: the skills this machine can send, and the upload that files one under the caller's department."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-skill-repo-controller

English | [中文](README.zh.md)

## Summary

The **skill repository controller** republishes the skill provider's publishing seam over Typert Remote. It answers two calls: list the skills this machine could send, and send one. The provider decides where the files land — under `skills/<department>/<skill>/`, named after the department the signed-in colleague belongs to — and records who uploaded them beside the files. The controller carries no state: it maps those records onto wire types, so the settings page never has to know a repository path or a token.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

Mount it beside the provider. It requires the `skillRepo` service and registers the `skillRepo` Remote namespace, so the browser reaches it through `ctx.remote.skillRepo`.

## Understand the implementation

`skills()` maps the provider's local list onto `SkillRepoLocalView`. `upload({ name })` validates the directory name and returns what the upload wrote, what already matched, and which repository paths already hold different bytes — those are reported, never overwritten, so one colleague cannot replace another's skill.

## Further Exploration

- [skill-repo](../../skill/skill-repo/README.md) — the provider that lists local skills and publishes one.
- [redaction-controller](../redaction-controller/README.md) — the neighbouring Remote owner, which is the shape this one follows.
- [remotes](../remotes/README.md) — the client assembly that mounts this namespace.
- [typert](../../typert/protocol/README.md) — the protocol both faces generate from.

-----

## Dev Note

Two `@Remote` methods, no state: `skills()` reads the provider, `upload()` asks it to publish one directory. Everything about where the files land lives in the provider, so a change of layout touches one package.

-----

## Model Experience

None, as the controller only answers calls from the settings page: publishing copies a skill directory into the repository and never touches a prompt, a tool result, or a model request.

#### KV Cache effect

None; this package assembles no provider request.

## Known Limitations and Deferred Work

**Runtime invariant:** No companion is published because the provider owns the record and this package only republishes it over the wire.

- Uploading only adds files. A skill that exists with different contents has to be renamed or edited by hand, because the surface has no overwrite and no delete.
- The file list stops at one megabyte per file; anything larger is reported as skipped rather than streamed in pieces.
- Nothing reconciles a published skill with the local copy afterwards, so a later edit is a second upload of the changed files.
