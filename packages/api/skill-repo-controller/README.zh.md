---
description: "技能发布事务的 Host 端 Remote 属主：本机可以送出哪些技能，以及把其中一个按调用者所属部门归档的那一次上传。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-skill-repo-controller

[English](README.md) | 中文

## 概述

**技能仓库控制器**把技能提供方的发布接口以 Typert Remote 重新发布出来。它只回答两件事：列出本机可以送出的技能，以及送出其中一个。文件落在哪里由提供方决定——放在 `departments/<部门>/<技能>/` 下，目录名取自登录同事所属的部门——并在文件旁边记下是谁上传的。控制器自身不保存状态：它把这些记录映射成可以在线上传输的类型，因此设置页既不需要知道仓库路径，也不需要知道令牌。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

挂在提供方旁边即可。它依赖 `skillRepo` 服务，并注册 `skillRepo` Remote 命名空间，浏览器通过 `ctx.remote.skillRepo` 访问。

<a id="understand-the-implementation"></a>

## 实现说明

`skills()` 把提供方的本机清单映射成 `SkillRepoLocalView`。`upload({ name })` 校验目录名，并返回写入了多少文件、多少个已经一致，以及哪些仓库路径里已经是不同的内容——这些只做报告、绝不覆盖，因此一个同事不会替换掉另一个同事的技能。

<a id="further-exploration"></a>

## 进一步探索

- [skill-repo](../../skill/skill-repo/README.zh.md) —— 列出本机技能并发布其中一个的 provider。
- [redaction-controller](../redaction-controller/README.zh.md) —— 相邻的 Remote 归属者，本包沿用它的形状。
- [remotes](../remotes/README.zh.md) —— 挂载该命名空间的客户端装配。
- [typert](../../typert/protocol/README.zh.md) —— 两侧面生成所依据的协议。

-----

<a id="dev-note"></a>

## 开发备注

两个 `@Remote` 方法，没有状态：`skills()` 读 provider，`upload()` 请它发布一个目录。文件落在哪里完全由 provider 决定，因此改布局只动一个包。

-----

<a id="model-experience"></a>

## 模型体验

无。控制器只回答设置页发起的调用：发布是把一个技能目录复制进仓库，既不改动提示词，也不改动工具结果或任何模型请求。

#### KV Cache 影响

无；该包不组装任何提供方请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

**运行不变式：** 不发布伴随包，因为记录归提供方所有，本包只是把它在线上重新发布。

- 上传只做新增。内容不同的同名技能需要人工改名或修改，因为这个界面既没有覆盖也没有删除。
- 单文件上限一兆字节；更大的文件只会被报告为已跳过，不会分片传输。
- 发布之后不再与本地副本对账，因此之后的修改等于把改过的文件再上传一次。
