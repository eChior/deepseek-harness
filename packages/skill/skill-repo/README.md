---
description: "The startup mirror that keeps a distribution's skills in a git repository, so a released skill reaches users without a new installer."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-repo

English | [中文](README.zh.md)

## Summary

A distribution that ships skills inside its installer can only add one by cutting a new release. This provider instead keeps a mirror of a git-hosted skill repository under `$DSH_HOME/skills-repo` and refreshes it at startup, then hands that directory to `skill-filesystem` through `customSkillDirs`. Publishing a skill becomes a push to the repository followed by the next client launch. The mirror is a plain working tree on disk: when the remote is unreachable, the previous copy stays in place and the session starts with the skills it already had.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin next to `skill-filesystem`, and point the filesystem provider at the mirror:

```yaml
- id: skill-repo
  name: '@deepseek-ai/dsh-skill-repo'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js dshHomePath('skills-repo', 'skills')
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set to `false` to keep the provider off the network entirely. |
| `url` | `http://10.151.5.175:3000/ITPublic/dsh-skills.git` | Remote to mirror. |
| `branch` | `main` | Branch to track. |
| `directory` | `$DSH_HOME/skills-repo` | Where the mirror lives. |
| `skillsDirectory` | `skills` | Subdirectory of the mirror holding the skills. |
| `timeoutMs` | `120000` | Per-command git timeout. |

### When to choose it

Choose it when the skill set is a moving target shared by many installs. Avoid it when skills must work offline on first run, or when they arrive through the installer or another provider.

<a id="understand-the-implementation"></a>
## Understand the implementation

`SkillRepository.sync()` runs once when the plugin loads and again on demand. It clones the configured branch at depth 1 when `directory` is not yet a working tree, and otherwise fetches that branch and hard-resets onto it, so a half-finished sync cannot leave a dirty tree behind. The result lands in `status`: `idle`, `syncing`, `ready`, or `failed`, alongside the mirror paths, the short revision, and a failure detail.

Concurrent calls share one in-flight sync, so a caller that arrives while startup sync runs joins it instead of cloning into the same directory twice.

Every git call runs without a shell, with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. A private remote that would otherwise prompt for a password fails fast instead of hanging the boot.

The provider never throws. A missing git binary, an unreachable remote, or a timeout is logged as a warning and written to `status.detail`; `skill-filesystem` keeps scanning whatever the mirror already contains.

## Model Experience

Indirectly, through the skill catalog: the mirror only decides which skill files exist on disk, and dsh-tool-skill owns every model-facing rendering of them.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

**Runtime invariant:** No runtime invariant companion is published; the plugin owns one status record and one sync entry point, and the mirror on disk is the only state either of them holds.

- **No offline seeding** — a first run with no network and no existing mirror yields no distribution skills at all; the provider does not bake a fallback copy into the package.
- **Startup sync does not block the catalog** — the first scan of a cold machine can finish before the clone does, so newly published skills appear on the session after the sync completes rather than in the one that started it.
- **No revision reporting to the user** — `status.revision` is available to other plugins but is not surfaced in the client UI.
