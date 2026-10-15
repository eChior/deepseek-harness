---
name: "tsd-reader"
description: "读取华润 TSD 加密文件（润文档/TSD-Header/SM9）。麒麟上通过本地控制通道就地解密、读完自动还原，不驱动任何 GUI；支持 Word、Excel、PPT、PDF、文本。用户要求读取被加密的文档、表格、演示或 PDF 时使用本 skill。"
version: "2.0.0"
agent_created: true
triggers:
  - "读取加密文档"
  - "TSD 加密"
  - "华润加密文档"
  - "润文档"
  - "解密读取"
  - "tsd-reader"
  - "加密文件读取"
  - "SM9 加密"
  - "加密表格"
  - "加密 Excel"
---

# TSD Reader — 读取 TSD 加密文件

> 麒麟（Linux）上走本地 TSD 控制通道：就地解密 → 读文本 → 立即还原成密文。
> 全程不打开 WPS、不模拟按键、不弹窗口、不需要用户操作。

## 什么是 TSD 加密

TSD-Header 是华润集团文档安全系统（润文档）使用的文件加密格式：

| 特征 | 说明 |
|------|------|
| 文件头 | `%TSD-Header-###%` 开头（20 字节内可判定） |
| 加密算法 | SM9（国密身份基加密 IBC） |
| 密钥管理 | 华润证书服务客户端 KeyService / 麒麟上的 `LSDHelper` |
| 授权范围 | 文件必须签发给当前用户，否则解密被拒 |
| 副作用 | 明文一旦落到**普通磁盘路径**会被安全箱重新加密，必须落 tmpfs 或内存 |

## 依赖环境

### 麒麟（Linux，推荐路径）

| 组件 | 是否必需 | 说明 |
|------|---------|------|
| `LSDHelper` | 必需 | 登录后由桌面会话自动启动，监听 `127.0.0.1`，端口 `10500 + uid % 5` |
| `libpeony-teclink-menu.so` | 必需 | `/usr/lib/<架构>/peony-extensions/` 下，自带完整 TSD 引擎 |
| Python 3 + PyQt5 | 必需 | 麒麟自带（实测 Python 3.8.10 + PyQt5 5.15.2） |
| `pdftotext` | 仅 PDF 需要 | poppler-utils |

`DISPLAY`、`LD_LIBRARY_PATH`、运行中的 peony **都不需要**。

### Windows

| 组件 | 说明 |
|------|------|
| KeyService.exe | 自动搜索安装路径，也可设 `CR_KEYSERVICE_HOME` |
| WPS Office | 自动搜索安装目录，也可设 `WPS_OFFICE_HOME`；`docpermission.dll` 在 `addons\docpermission\` |
| Python 3 + pywin32 | COM 读取用 |

Windows 上没有控制通道，只能通过 WPS COM 读取。**Microsoft Office 不能替代 WPS**。

## 读取流程

```
环境检查 → 类型识别 → 文件是密文？
  ├─ 否 → 直接解析
  └─ 是 → 备份 → 控制通道解密 → 解析内容 → 恢复密文（finally 无条件执行）
```

解析按容器类型直接读 XML，**不经过 WPS、不转 PDF**：

| 类型 | 解析方式 |
|------|---------|
| Word (.docx) | ZIP → `word/document.xml`、页眉页脚 → `<w:t>` |
| Excel (.xlsx) | ZIP → `xl/sharedStrings.xml`、`xl/worksheets/sheet*.xml` → `<t>` |
| PPT (.pptx) | ZIP → `ppt/slides/slide*.xml` → `<a:t>` |
| PDF | `pdftotext -layout` |
| 文本 | 直接读取 |

## 使用方法

```bash
# 读取一个或多个文件，输出 JSON
python3 scripts/tsd_reader.py <文件> [<文件> ...]

# 只看环境（插件路径、服务状态、控制端口、uid）
python3 scripts/tsd_reader.py --check
```

输出示例：

```json
[
  {
    "path": "/tmp/供应商申请表.xlsx",
    "kind": "excel",
    "encrypted": true,
    "ok": true,
    "text": "--- xl/sharedStrings.xml ---\n简称\n申请主体\n…",
    "characters": 42589,
    "cjkCharacters": 13968
  }
]
```

`ok` 为假时带 `code`：`missing` / `service` / `decrypt-failed` / `empty-output` /
`still-encrypted` / `unsupported-platform` / `error`。退出码 0 = 全部成功，1 = 有失败，2 = 参数错误。

## 关键注意事项

1. **不驱动 GUI**：麒麟上不打开 WPS、不模拟按键、不截图。这是本版本与前一代最大的区别。
2. **失败必还原**：解密前先 `cp -p` 备份到临时目录，`finally` 里用备份还原（不依赖 TSD 能否成功回写），任何异常路径都不留明文。
3. **原文只读**：还原后文件属主、权限、时间戳与原来一致；不产生任何副本在用户目录。
4. **结果弹窗**：`LSDHelper` 每次操作后无条件弹结果框（服务端无静默开关），实际调用时由 daemon 线程 50ms 轮询 `xdotool` 自动关闭，用户最多看到一次极短闪现。
5. **授权绑定**：只能解密签发给当前用户的文件；别人的文件会返回 `decrypt-failed`。
6. **扫描件限制**：纯图片内容（扫描件、二维码）没有文本层，需要 OCR 才能提取。
7. **不要落普通磁盘**：任何明文中间产物都必须放 `$TMPDIR`（麒麟是 tmpfs）或内存。

## 脚本参考

| 脚本 | 用途 |
|------|------|
| `scripts/tsd_reader.py` | 主入口：环境检查、解密、读取、还原 |
| `references/environment.md` | 组件定位、缺组件时的提示模板、Windows 侧的注册表键 |

排障要点：`python3 scripts/tsd_reader.py --check` 会打印库路径、`LSDHelper` 是否在跑、控制端口与 uid —— 这三项对不上时，先确认用户已正常登录桌面会话。
