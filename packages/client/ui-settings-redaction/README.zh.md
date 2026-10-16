---
description: "dsh Web 客户端设置中的只读脱敏状态标签页：词表修订与来源、已编译规则数、本进程替换次数，以及仍在本机排队的词条请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-redaction

[English](README.md) | 中文

## 概述

**脱敏状态**标签页用于**查看**会话脱敏，而不提供修改入口。它显示宿主加载的是哪一版词表、这份词表来自何处、编译出多少词条与多少条正则、本进程做过多少次替换，以及还有多少条词条请求在本机等待交付通道。页面同时说明脱敏常开，因此它只解释、不配置。标签页处理加载、失败与重试状态，会指出词表未加载的原因，也会指出某次刷新沿用了已加载的规则。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开设置中的「插件」分区并选择**脱敏状态**标签页。插件激活期间不会读取 Remote：首次选择该标签页时才挂载组件，随后组件通过 `api-remotes` 调用 `ctx.remote.redaction.status()`。**刷新**会重新执行同一次读取。

除刷新之外，页面不携带任何控件。提供方按设计没有关闭开关，进入会话的每条提示与每份工具结果都会先过词表；该页面存在的意义是让这道关卡可被观察，而不是可被调整。

### 各行的含义

**词表修订**是已加载词表声明的修订号，未加载时显示为一条短划线。**词表来源**说明编译出的规则取自哪一份副本——随客户端分发、本机缓存，或内网发布。**已编译规则**分别统计词条与正则的条数，因为词条是精确匹配，而正则按 JavaScript 子集编译。**本进程替换次数**统计宿主启动以来被改写的命中次数，涵盖每条包含词条的提示与工具结果。**待提交词条**统计在本机等待交付通道的词条数。**上次检查发布**显示提供方最近一次询问发布端的时间，首次尝试之前显示为「从未」。

两条提示只在适用时出现。词表被阻断时，页面指出当前未替换任何内容的原因——文件读不到、词表无法解析，或正则编译失败。某次刷新沿用了已加载的规则时，页面指出原因，使过期的修订号可见而非静默。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该标签页是只读投影：它持有一份视图状态快照，在挂载与刷新时各读一次宿主。

### 注册

浏览器插件注册一个 id 为 `redaction`、order 为 `20` 的本地化 `settings.plugins.tab` 贡献，排在「插件列表」之后。注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。

### 读取状态

`inject` 只返回一个回调 `status`：它 `await` `ctx.remote.redaction.status()` 并解包结果，被拒的调用会抛出，因此组件渲染共享的失败状态而不是一份残缺记录。读取发生在带存活标记的 effect 中，卸载后才到达的响应会被丢弃。

### 视图类型为何声明在宿主侧

宿主控制器在自己的 `./types` 子路径里声明 `RedactionStatusView`，而不是 re-export 提供方的 `RedactionStatus`。Remote 边界背后的分析器会遍历公共类型子路径的声明，而一个只 re-export 另一个模块的子路径不会给它留下属于自身的声明。客户端仅以 type-only 方式导入该视图类型，因此浏览器 bundle 不携带宿主代码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖设置分区、Remote 调用，以及页面所渲染的记录。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.plugins.tab` 的领域底座。
- [api-remotes](../../api/remotes/README.zh.md)——`redaction.status()` 背后的 Remote BFF 表面。
- [redaction-controller](../../api/redaction-controller/README.zh.md)——通过 `redaction` 命名空间重新发布提供方记录的宿主侧。
- [redaction](../../security/redaction/README.zh.md)——拥有该记录与词表的提供方。

-----

<a id="model-experience"></a>
## 模型体验

无。该标签页只读取提供方已经在每条提示与每份工具结果上执行的那道关卡的状态。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义页面能展示的范围；它们是当前包约束。

- **每次挂载或刷新只读取一份快照**：标签页不订阅提供方变化，因此计数只在用户刷新时推进；其他会话的替换也计入同一个进程级总数。
- **不提供词条编辑**：页面只报告排队中的请求，既不新增、不删除，也不交付；提交与交付属于另外的工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只持有一个只读 Settings contribution。
