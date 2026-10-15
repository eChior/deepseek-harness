---
description: "启动时把发行版的技能镜像到一个 git 仓库，让新发布的技能不必重装即可到达用户。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-repo

[English](README.md) | 中文

## 概述

把技能打进安装包的发行版，只能靠再出一个版本才能加技能。这个提供者改为在 `$DSH_HOME/skills-repo` 下维护一份 git 技能仓库的镜像，启动时通过 HTTP 读取分支压缩包来刷新，再把该目录通过 `customSkillDirs` 交给 `skill-filesystem`。发布一个技能于是变成「推送到仓库 + 用户下次启动客户端」。镜像是磁盘上一份普通工作树，且无需 git 二进制：远端不可达时，上一份副本留在原地，本次会话用已有的技能照常启动。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂在 `skill-filesystem` 旁边，并让文件系统提供者指向镜像：

```yaml
- id: skill-repo
  name: '@deepseek-ai/dsh-skill-repo'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js dshHomePath('skills-repo', 'skills')
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 则完全不碰网络。 |
| `url` | `http://10.151.5.175:3000/ITPublic/dsh-skills.git` | 要镜像的远端。 |
| `branch` | `main` | 跟踪的分支。 |
| `directory` | `$DSH_HOME/skills-repo` | 镜像所在目录。 |
| `skillsDirectory` | `skills` | 镜像中存放技能的子目录。 |
| `timeoutMs` | `120000` | 每次请求的超时。 |

### 何时选用

当技能集是众多安装共享、且会持续变化时选它。技能必须在首次运行离线可用、或技能来自安装包与其它提供者时，不要选它。

<a id="understand-the-implementation"></a>
## 了解实现

`SkillRepository.sync()` 在插件加载时跑一次，也可按需再跑。它从承载远端的服务器下载分支压缩包，解包到镜像旁的暂存目录，再把完成的副本换进来，因此半途中断的同步不会留下脏工作树。结果落在 `status` 上：`idle`、`syncing`、`ready` 或 `failed`，同时带上镜像路径、短版本号与失败详情。

并发调用共享同一次进行中的同步，因此在启动同步运行期间到达的调用者会加入它，而不会向同一目录再解包一次。

同步通过 HTTP 读取压缩包，从不调用 git 二进制，因此没装过 git 的客户端机器同样能收到发行版的技能。版本号取自宿主的分支接口，该接口无应答时上报为 `null`。

该提供者从不抛错。宿主不可达、压缩包被拒或超时都只记一条警告并写入 `status.detail`；`skill-filesystem` 继续扫描镜像里已有的内容。

<a id="model-experience"></a>

## 模型体验

间接地，通过技能目录：镜像只决定磁盘上存在哪些技能文件，而这些文件面向模型的一切呈现都由 dsh-tool-skill 负责。

#### KV 缓存影响

模型请求前缀不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

**运行时不变式：** 不发布运行时不变式伴随包；插件只拥有一个状态记录与一个同步入口，二者持有的唯一状态就是磁盘上的镜像。

- **没有离线种子** —— 首次运行若既无网络又无既有镜像，就不会有任何发行版技能；本包内不内置兜底副本。
- **启动同步不阻塞目录扫描** —— 冷机器的首次扫描可能先于压缩包落地，因此新发布的技能出现在同步完成之后的会话，而不是发起同步的那一个。
- **不向用户报告版本** —— `status.revision` 可供其它插件读取，但没有暴露到客户端界面。
