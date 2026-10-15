---
description: "Package map for the security capability family: the redaction provider that rewrites sensitive values out of text before a session can keep them."
kind: "package-group"
---

# security/ — data protection

English | [中文](README.zh.md)

## Summary

The `security/` group holds providers that decide what a session is allowed to keep. Today it carries one package: `redaction/` matches an operator-maintained term list against prompt text and rewrites every hit into a stable placeholder, while the values it replaced live only in memory and die with the process. Use this group when a deployment must keep specific values out of a session log, a tool result, or a model request, rather than when it only wants to find them afterwards.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package provides this family today. Its README covers the term-list format, the placeholder contract, and what a consumer still has to wire.

| Package | Role | ctx key |
|---|---|---|
| [`redaction/`](redaction/README.md) | Rewrite matched identifiers and figures into stable placeholders before any caller appends text to a session | `ctx.redaction` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this provider follows.
- [Package documentation standard](../AGENTS.md) — the README contracts every package in this group follows.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
