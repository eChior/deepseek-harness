---
description: "设置里的技能上传标签页：把本机的一个技能发布到部门技能仓库，每行一个技能，按调用者所属部门归档。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

[English](README.md) | 中文

## 概述

**技能上传**标签页列出本机可以发布的每个技能，并按请求送出其中一个。每行显示技能自己的说明、文件数与大小，以及这次上传的结果——写入了多少文件、多少个已经一致、哪些文件仓库里已经是不同内容（这些只报告、不覆盖）。页面从不显示仓库路径：它说明技能是否送到了，而不说明落在哪里。部门技能不会被自动同步给任何人，同事在技能管理器里自行安装。

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

打开设置里的插件分区，选择**技能上传**标签页。标签页在插件激活时不读取任何 Remote：选中它才会挂载组件，组件随后调用 `ctx.remote.skillRepo.skills()`。**刷新**重跑同一次读取，**上传**发布该行对应的技能。

<a id="understand-the-implementation"></a>

## 实现说明

插件只注册一个插槽和一份词表。`SkillUploadTab` 持有清单与每个技能各自的上传状态，因此某一行失败不会影响其它行。`ctx.remote.skillRepo.upload({ name })` 只传目录名；部门与上传者记录都由提供方决定。

<a id="further-exploration"></a>

## 进一步探索

- [skill-repo](../../skill/skill-repo/README.zh.md) —— 读取本机技能、把它们写进仓库的 provider。
- [skill-repo-controller](../../api/skill-repo-controller/README.zh.md) —— Host 侧，把该调用以 `skillRepo` 命名空间重新发出。
- [ui-settings](../ui-settings/README.zh.md) —— 声明 `settings.plugins.tab` 的领域基座。
- [ui-settings-redaction](../ui-settings-redaction/README.zh.md) —— 相邻的脱敏页，本页沿用它的形状。

-----

<a id="dev-note"></a>

## 开发备注

本页与脱敏页同构：同一个槽位、同样的 Locale 注册、同样的 Remote 解包。给某行加一列，意味着加一个 Locale 键，而不是搭一张表。

-----

<a id="model-experience"></a>

## 模型体验

无。标签页只列出本机技能并请求宿主发布其中一个：这里没有任何内容进入提示词、工具结果或模型请求。

#### KV Cache 影响

无；该包不组装任何提供方请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

**运行不变式：** 不发布伴随包。本包拥有的设置贡献，其状态存放在宿主提供方里。

- 清单只覆盖技能根目录。放在项目目录里的技能需要先复制过去。
- 既没有覆盖也没有删除：发生冲突只能通过重命名本地技能解决。
- 上传按文件进行，因此二十个文件的技能会产生二十个提交，没有单次批量提交。
- 页面在上传前不显示将要归档到哪个部门。
