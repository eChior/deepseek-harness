---
description: "通过华润 RWork 身份网关完成登录、并展示得到的姓名与头像的账号提供者，用来替换 DeepSeek 平台账号。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hrzszy-account

[English](README.md) | 中文

## 概述

本发行版让用户通过租户自有的身份网关登录，而不是 DeepSeek 平台。它实现的是产品其余部分早已在消费的那个账号服务：客户端在桌面窗口里打开 RWork 登录页，宿主读取由此产生的会话 cookie，用它换取用户姓名与头像，并作为一条普通凭据授予保存。模型访问不受影响，因为模型用 API Key 认证，与本账号无关。需要在自有租户内完成登录的部署选用本包；由于共享同一份账号契约，客户端、RPC 控制器与设置界面都无需改动。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用本提供者替换平台账号提供者即可；账号服务名仍是 `deepseekAccount`，因此图中其它部分都不变。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiOrigin` | `https://app.rwork.crc.com.cn` | 提供身份接口的来源。 |
| `loginOrigin` | `https://accounts.rwork.crc.com.cn` | 提供登录页的来源。 |
| `appId` | `2` | 网关要求的应用 id。 |
| `requestTimeoutMs` | `15000` | 身份请求超时。 |
| `attemptTimeoutMs` | `600000` | 一次登录尝试的存活时长。 |

### 何时选用

当部署绑定租户、且用户通过企业身份网关登录时选它。产品必须改用上游平台账号登录时不要选它，那种情况下平台提供者仍是同一服务的正确实现。

<a id="understand-the-implementation"></a>
## 了解实现

`startSignIn` 记录一次处于 `waiting-browser` 阶段的尝试，并把由 `loginOrigin` 拼出的 `authorizeUrl` 交给客户端。客户端在自建窗口里打开该地址，轮询窗口的 cookie 罐，再通过 `acceptExternalSession` 把 cookie 交回。该方法调用身份接口，成功后写入一条授予记录，其 payload 保存 cookie 与解析出的用户，并把该尝试置为成功。

`getProfile` 读取该授予记录并上报 `id`、`name` 与 `avatarUrl`，这正是设置界面与账号菜单渲染的内容。`getState` 依据同一条记录上报已登录或未登录。

`getBalance`、`getUnnotifiedBonuses`、`resolveToken` 与 `getPlatformSession` 是刻意留空的：本部署没有余额账本、没有奖励计划，也没有平台会话或 bearer token，因为模型用 API Key 认证。`signOut` 删除该授予记录。

基类提供者把 `acceptExternalSession` 声明为拒绝，因此无法接受宿主捕获会话的提供者不受该扩展影响。

<a id="model-experience"></a>

## 模型体验

无。身份网关不注册任何模型上下文或工具；会话 cookie 只影响宿主侧 HTTP 认证。

#### KV 缓存影响

模型请求前缀不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

**运行时不变式：** 不发布运行时不变式伴随包；提供者只拥有一条凭据记录及其中解析出的身份，而它读取时所经的传输属于身份网关，不属于本包。

- **没有刷新与过期处理** —— 网关之后作废的 cookie 会表现为身份请求失败，而不是退出登录，因此用户会一直看到原有账号，直到别处清除它。
- **没有租户发现** —— `appId` 来自配置，因此第二个租户需要第二个 profile，而不是一次查询。
- **余额与奖励界面保持为空** —— 客户端按共享契约渲染它们并显示空内容，这是有意为之而非未实现。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 —— 点击展开</summary>

无。

</details>
