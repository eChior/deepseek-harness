---
description: "Settings tab that publishes a skill from this machine into the department skill repository, one row per skill, filed under the caller's department."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

English | [中文](README.zh.md)

## Summary

The **Skill upload** tab lists every skill this machine could publish and sends one on request. Each row shows the skill's own description, its file count and size, and what the upload did — files written, files that already matched, and files the repository already holds with different contents, which are reported instead of overwritten. The page never shows a repository path: it says whether a skill arrived, not where it landed. A department's skills are not synced to anyone; colleagues install them from the skills manager.

## Use this package

Open the Plugins section in Settings and select the **Skill upload** tab. The tab reads no Remote during activation: selecting it mounts the component, which then calls `ctx.remote.skillRepo.skills()`. **Refresh** re-runs the same read, and **Upload** publishes the row it belongs to.

## Understand the implementation

The plugin registers one slot and one dictionary. `SkillUploadTab` holds the list and a per-skill upload state, so a failure on one row leaves the others usable. `ctx.remote.skillRepo.upload({ name })` carries the directory name only; the provider decides the department and the uploader record.

## Model Experience

None, as the tab only lists local skills and asks the host to publish one: nothing here reaches a prompt, a tool result, or a model request.

#### KV Cache effect

None; this package assembles no provider request.

## Known Limitations and Deferred Work

**Runtime invariant:** No companion is published. This package owns a Settings contribution whose state lives in the host provider.

- The list covers the skills root only. A skill that lives in a project directory has to be copied there first.
- There is no overwrite and no delete: a conflict has to be resolved by renaming the local skill.
- An upload is per file, so a skill with twenty files makes twenty commits; there is no single-commit batch.
- The page does not show which department it will file under before the upload runs.
