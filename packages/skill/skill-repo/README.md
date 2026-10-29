---
description: "The startup mirror that keeps a distribution's skills in a git repository, so a released skill reaches users without a new installer."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-repo

English | [中文](README.zh.md)

## Summary

A distribution that ships skills inside its installer can only add one by cutting a new release. This provider instead keeps a mirror of a git-hosted skill repository under `$DSH_HOME/skills-repo`, refreshes it at startup by reading the branch archive over HTTP, and publishes every skill it carries into `$DSH_HOME/skills`, the user skill root that `skill-filesystem` already scans. Publishing a skill becomes a push to the repository followed by the next client launch, and no git binary is needed: when the remote is unreachable, the copy already on disk stays in place.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin on its own; every skill the repository carries is published into the user skill root, which the filesystem provider already scans:

```yaml
- id: skill-repo
  name: '@deepseek-ai/dsh-skill-repo'
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set to `false` to keep the provider off the network entirely. |
| `url` | `http://10.151.5.175:3000/ITPublic/dsh-skills.git` | Remote to mirror. |
| `branch` | `main` | Branch to track. |
| `directory` | `$DSH_HOME/skills-repo` | Where the mirror lives. |
| `skillsDirectory` | `skills` | Subdirectory of the mirror holding the skills the archive carries. |
| `publishDirectory` | `$DSH_HOME/skills` | Skill root the synced skills are published into. |
| `bundledDirectory` | the `assets/skills` copy inside this package | Skills used while no mirror exists yet and the remote stays unreachable. |
| `timeoutMs` | `120000` | Per-request timeout. |

### When to choose it

Choose it when the skill set is a moving target shared by many installs. Avoid it when skills must work offline on first run, or when they arrive through the installer or another provider.

<a id="understand-the-implementation"></a>
## Understand the implementation

`SkillRepository.sync()` runs once when the plugin loads and again on demand. It downloads the branch archive from the host that serves the remote, unpacks it into a staging directory beside the mirror, and swaps the finished copy in, so a half-finished sync cannot leave a dirty tree behind. The result lands in `status`: `idle`, `syncing`, `ready`, or `failed`, alongside the mirror paths, the short revision, and a failure detail.

Concurrent calls share one in-flight sync, so a caller that arrives while startup sync runs joins it instead of unpacking into the same directory twice.

Once the mirror is in place, `publish()` copies every directory the archive carries that holds a `SKILL.md` into `publishDirectory`. A name this provider published on an earlier sync is replaced, and a directory it never published is left alone with a warning, so a hand-written skill that shares a name with a repository skill survives. Skills the repository no longer carries leave the published set too. The names it owns are recorded in `.dsh-skill-repo-published.json` beside the mirror rather than inside it, because the mirror itself is replaced on every sync.

The sync reads the archive over HTTP and never runs a git binary, so a client machine that has no git installed still receives the distribution's skills. The revision is read from the host's branch endpoint and is reported as `null` when that endpoint does not answer.

The provider never throws. An unreachable host, a refused archive, or a timeout is logged as a warning and written to `status.detail`; `skill-filesystem` keeps scanning whatever the mirror already contains.

Publishing is three operations over the department tree. `skillEntries()` reads one tree listing and pairs each local skill with the copy its department already published, so the page can say which side is newer; `uploadSkill(name, mode)` sends a skill, replacing an existing copy only when the caller asked for an update; `removeSkill(name)` deletes the files of a copy whose `.uploader.json` names the signed-in colleague, and refuses any other. `departmentSkills()` answers what every department has published, which is how a colleague finds a skill without opening the repository by hand.

When the remote never answers and the machine has no readable mirror — a fresh install that has never seen the intranet, or a mirror left empty or half-written by an interrupted sync — `seed()` copies the skills this package carries out of `bundledDirectory` through the same staging step, publishes them, and reports `source: 'bundled'` with a null revision. A machine whose mirror still holds a readable skill keeps the remote copy instead, because that one is newer than the one this build shipped.

## Model Experience

Indirectly, through the skill catalog: the mirror only decides which skill files exist on disk, and dsh-tool-skill owns every model-facing rendering of them.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

**Runtime invariant:** No runtime invariant companion is published; the plugin owns one status record and one sync entry point, and the mirror on disk is the only state either of them holds.

- **Bundled skills are a floor, not a snapshot** — a first run with no network falls back to the copy inside this package, which is only as new as the release that shipped it, and the provider reports it as `bundled` instead of fetching anything.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

- The default remote points at the intranet gitea (`http://10.151.5.175:3000/ITPublic/dsh-skills.git`); a deployment on another host sets `url` in its own profile.
- `assets/skills` holds the skills this build carries. It is refreshed by copying them out of the skills repository before a release rather than by a build step, so a release can deliberately carry a floor older than the repository.
- The published-name manifest lives beside the mirror instead of inside it, because the mirror directory is replaced wholesale on every sync.
- Tests: `pnpm vitest run packages/skill/skill-repo`.

</details>
- **Startup sync does not block the catalog** — the first scan of a cold machine can finish before the archive lands, so newly published skills appear on the session after the sync completes rather than in the one that started it.
- **No revision reporting to the user** — `status.revision` is available to other plugins but is not surfaced in the client UI.
- **Publishing owns only what it wrote** — the record of published names lives beside the mirror, so a skill directory dropped into `publishDirectory` by hand is never replaced, but neither is it removed when the repository later uses that name.
