---
description: "安全能力系列的包映射：在会话留下痕迹之前，就把敏感值从文本里改写掉的脱敏提供者。"
kind: "package-group"
---

# security/ — 数据保护

[English](README.md) | 中文

## 概述

`security/` 组承载决定「会话允许留下什么」的提供者。目前它只有一个包：`redaction/` 把运维维护的词表与提示词文本比对，把每一处命中改写成稳定占位符，而被替换掉的值只存在于内存，随进程一起消失。当部署需要把特定值挡在会话日志、工具结果或模型请求之外时使用本组，而不是事后才想找出它们。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本系列目前由一个包提供。它的 README 覆盖词表格式、占位符约定，以及消费者还需要接哪些线。

| 包 | 职责 | ctx key |
|---|---|---|
| [`redaction/`](redaction/README.zh.md) | 在任何调用方把文本写入会话之前，把命中的标识与数字改写成稳定占位符 | `ctx.redaction` |

-----

<a id="related-documentation"></a>
## 相关文档

- [能力 seam](../../docs/capability-seams.zh.md) — 本提供者遵循的 Service Definition／Service Provider／Consumer 划分。
- [包文档规范](../AGENTS.md) — 本组每个包都遵循的 README 约定。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
