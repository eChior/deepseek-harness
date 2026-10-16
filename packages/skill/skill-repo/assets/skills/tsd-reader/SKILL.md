---
name: tsd-reader
version: 3.0.0
description: >-
  读取华润 TSD 加密文件（润文档 / TSD-Header / SM9）。Windows 走 WPS COM
  （KWPS/KET/KWPP），麒麟走本地控制通道就地解密、读完自动还原；两平台都不把正文写进
  工具输出，默认只把正文落临时文件。支持 Word、Excel、PPT、PDF、文本。当用户要求读取
  加密文档、加密表格、加密演示或加密 PDF，或提到 TSD、润文档、华润加密文档、SM9、
  解密读取、tsd-reader 时，使用本技能。
---

# TSD Reader — 读取 TSD 加密文件

> **两平台两条路径，同一份脚本自动分派**：
> Windows → WPS COM（`KWPS`/`KET`/`KWPP` 三个 ProgID，`docpermission.dll` 在 WPS 进程内解密）；
> 麒麟/Linux → `LSDHelper` 本地控制通道（`127.0.0.1:10500`，就地解密 → 读文本 → 立刻复原密文）。
> 两平台都不驱动 GUI 交互、不弹窗等人点、不把正文打印到工具输出。

## 什么是 TSD 加密

TSD-Header 是华润集团文档安全系统（润文档）使用的文件加密格式：

| 特征 | 说明 |
|------|------|
| 文件头 | `%TSD-Header-###%` 开头（前 16 字节即可判定） |
| 加密算法 | SM9（国密身份基加密 IBC） |
| 授权范围 | 文件必须签发给当前用户，否则解密被拒 |
| 磁盘特征 | 占用常是 4096 的整数倍（如 16384、49152） |
| 副作用 | 明文落到受管路径可能被安全箱**重新加密**，扩展名不同结果不同 |

## 平台差异（先看这张表）

| 维度 | Windows | 麒麟 / Linux |
|------|---------|-------------|
| 解密通道 | WPS COM：`KWPS.Application` / `KET.Application` / `KWPP.Application` | `LSDHelper` 控制通道（`libpeony-teclink-menu.so` 的 `CTcpCliIcon::RequestDecryptFiles`） |
| 谁执行解密 | `docpermission.dll`，在 **WPS 进程内** | `LSDHelper` 服务端 |
| Python 的角色 | 必需：`pywin32` 驱动 COM，并读回正文 | **不解析密文**：只把路径交给通道，解密后再读文本 |
| 是否改动原文件 | **否**：COM 只读打开，磁盘密文一字不动 | **是**：就地解密 → 读完 `finally` 用备份还原 |
| 需要 KeyService | **不需要**（实测：解密由插件在内存完成） | 不适用 |
| 是否用 WPS | 必需（Microsoft Office 不可替代） | **完全不用 WPS** |
| GUI 依赖 | 无（COM 无窗口） | 无；`xdotool` 可选，仅用于自动关掉服务端提示框 |
| 明文去向 | `--out` 指定的临时文件（`.log`） | 自动落 `$TMPDIR`（麒麟是 tmpfs）里的临时文件 |

一句话：**Windows 靠 WPS 插件在进程内解密，Linux 靠 LSDHelper 的加密解密通道**；两侧都不能、也不需要自己实现 SM9。

## 依赖环境

### Windows

| 组件 | 必需 | 实测值 |
|------|:----:|--------|
| WPS Office | 必需 | `D:\WPS Office\<版本>\office6` |
| 润文档插件 `docpermission.dll` | 必需 | `…\office6\addons\docpermission\docpermission.dll`（约 4.7 MB） |
| Python 3 + pywin32 | 必需 | 任一本机 Python 3 皆可 |
| KeyService | **不需要** | 位置 `C:\ChinaResources\KeyService`，仅用于环境报告 |
| Microsoft Office | **不可替代** | 打开 TSD 文件只会看到乱码二进制 |

### 麒麟 / Linux

| 组件 | 必需 | 说明 |
|------|:----:|------|
| `LSDHelper` | 必需 | 登录后由桌面会话自动启动，监听 `127.0.0.1`，端口 `10500 + uid % 5` |
| `libpeony-teclink-menu.so` | 必需 | `/usr/lib/<架构>/peony-extensions/`，自带完整 TSD 引擎 |
| Python 3 + PyQt5 | 必需 | 麒麟自带（实测 3.8.10 + PyQt5 5.15.2） |
| `xdotool` | 可选 | 自动关掉 `LSDHelper` 的结果弹窗；缺失时弹窗会留在屏幕上 |
| `pdftotext` | 仅 PDF | poppler-utils |

`DISPLAY`、`LD_LIBRARY_PATH`、运行中的 peony、WPS **都不需要**。

## 使用方法

```bash
# 【默认｜正文不进工具输出】正文写入临时文件，stdout 只回路径 + 元数据
python3 scripts/tsd_reader.py "<加密文件>" ["<加密文件>" ...]

# 指定正文落地路径（目标扩展名不安全时会自动改成 .log）
python3 scripts/tsd_reader.py --out <临时文件.log> "<加密文件>"

# 只要校验元数据，不要正文
python3 scripts/tsd_reader.py --meta "<加密文件>"

# 环境检查（不读文件）
python3 scripts/tsd_reader.py --check

# 直出正文到 stdout —— 正文会进工具输出块，只在没有文件读取手段时才用
python3 scripts/tsd_reader.py --text "<加密文件>"
```

三步走（推荐）：

```bash
python3 scripts/tsd_reader.py "<加密文件>"   # ① stdout 只有 out 路径 + 元数据
# ② 用文件读取工具读那个 out 路径，完整正文原样进上下文
# ③ 立即删除该临时文件
```

输出示例（**不含正文**，可安全出现在工具调用结果里）：

```json
{
  "out": "/tmp/tsd-out-48213-供应商申请表.xlsx.log",
  "files": [
    {
      "path": "/home/user/供应商申请表.xlsx",
      "kind": "excel",
      "encrypted": true,
      "characters": 42589,
      "cjkCharacters": 13968,
      "ok": true,
      "unchanged": true
    }
  ]
}
```

`ok` 为假时带 `code`：`missing` / `service` / `decrypt-failed` / `empty-output` /
`still-encrypted` / `unsupported-platform` / `missing-plugin` / `error`。
退出码 0 = 全部成功，1 = 有失败，2 = 参数错误。`unchanged` 是读完前后原文 sha256 是否一致。

## 读取流程

```
--check 环境探测 → 类型识别 → 文件是密文（%TSD 头）？
  ├─ 否 → 按容器类型直接解析（零第三方依赖）
  └─ 是 → sha256 存证 → 备份 → 平台通道解密 → 解析内容
           → finally：还原 + chmod + 删备份 + 比对 sha256
```

解析按容器类型直接读 XML，**不经过 WPS 导出、不转 PDF**：

| 类型 | 解析方式 |
|------|---------|
| Word (.docx) | ZIP → `word/document.xml`、页眉页脚 → `<w:t>` |
| Excel (.xlsx) | ZIP → 共享字符串表 + 按单元格类型解析 `sheet*.xml`（见下） |
| PPT (.pptx) | ZIP → `ppt/slides/slide*.xml` → `<a:t>` |
| PDF | `pdftotext -layout` |
| 文本 | 直接读取 |

### Excel 解析要点（易错）

只抓 `<t>` 标签会**整列丢掉数字**（数字存在 `<v>` 里）。正确做法是按 `t` 属性分流：

- `t="s"` → `<v>` 是 `sharedStrings.xml` 的**索引**，需查表
- `t="inlineStr"` → 文本在 `<t>` 里
- 缺省（`n`）→ 文本在 `<v>` 里

另外用 `r="A1"` 里的列字母还原空列（`_column_index`），并用
`workbook.xml` + `_rels/workbook.xml.rels` 把 `sheetN.xml` 映射成真实工作表名。
输出按行制表符分隔，空行跳过。

## 关键注意事项

1. **正文不进工具输出**：默认模式与 `--out` 都把正文写文件，stdout 只留路径与元数据；
   再由宿主 `read` 该文件、用完立即删。不要在主会话跑 `--text`，不要走子代理，也不要把正文概括成要点。
2. **`--out` 扩展名自动纠正**：`.txt`/`.xlsx`/`.py` 会被安全箱二次加密，脚本自动改写为 `.log`，
   保证 `read` 到的是明文。推荐直接给 `.log`。
3. **临时文件必须删**：`read` 完立刻删除，不要把明文留在工作目录。
4. **Windows 只读打开**：Word/Excel/PPT 均以 `ReadOnly=True` 打开，关闭前置 `Saved=True`
   或直接 `Close()`，磁盘上的密文不被回写。
5. **Linux 失败必还原**：解密前备份到临时目录（扩展名 `.bak` 规避安全箱），`finally` 里无条件还原，
   属主/权限/时间戳保持，异常、超时、中断都不留明文。
6. **原文只读校验**：读完比对 sha256，`unchanged` 为 `true` 才算干净；该字段在默认模式与
   `--out` 模式下都出现在 stdout 的元数据里。
7. **Python 可能是白名单进程**（Windows）：同一批文件同一瞬间，Python 读到的可能是明文
   （`PK\x03\x04`），PowerShell 读到的是 `%TSD-Header` 密文。`encrypted` 字段只表示
   "该进程当下看到的是不是密文"，两条分支都已正确处理，不要据此判定文件没加密。
8. **授权绑定**：只能解密签发给当前用户的文件；别人的文件会 `decrypt-failed`。
9. **扫描件限制**：纯图片内容（扫描件、二维码）没有文本层，需要 OCR 才能提取。
10. **路径含空格**：加引号；多文件时输出文件里带 `===== 路径 =====` 分隔线。

## 与脱敏插件配合（会话里不留原文）

dsh 的 `redaction` 插件在**入站路径**改写文本：用户消息与工具结果在写入会话之前，
命中词表的条目会被换成稳定占位符（`[工艺-1]`、`[编号-2]`）。所以正确顺序是：

1. **先解密落文件**：`tsd_reader.py "<加密文件>"`，正文进临时文件（麒麟 `/tmp` 是 tmpfs，
   Windows 是 `%TEMP%`），命令输出只有路径与元数据。
2. **再用文件读取工具读那个路径**：正文经 `read` 进入上下文时已被换成占位符，
   写进 `~/.dsh/sessions/**/*.jsonl` 的就是占位符，不是原文。
3. **立刻删掉临时文件**：脱敏只作用于**会话**，临时文件里仍是明文。

| 环节 | 明文在哪 | 谁负责 |
|------|---------|-------|
| 磁盘上的加密原件 | `%TSD` 密文 | 脚本只读打开 / 读完还原，内容不被改写 |
| 临时正文文件 | 明文（tmpfs / `%TEMP%`） | **你**——读完立刻删 |
| 工具调用输出 | 只有路径 + 元数据 | 脚本的默认模式 |
| 会话记录 `*.jsonl` | 占位符 | `redaction` 插件 |
| 模型看到的上下文 | 占位符 | 同上 |

两条不能做的事：

- **不要用 `--text` 换"看得更清楚"**：正文会进工具输出块。虽然同样过脱敏，
  但多绕一层暴露面，也失去"读完即删"这一步的机会。
- **不要把正文概括成要点再复述**：概括出的具体数值、编号、人名会以 **assistant 文本**
  写进会话，而 assistant 输出**不走脱敏**（挂点只在入站与工具结果上）。
  模型上下文里既然已是占位符，就不要试图"还原"它。

脱敏只在**命中词表**时生效：词表没覆盖的敏感内容（例如不在词表里的对方单位名称、
自由文本里的金额）仍会以原文进会话。涉密程度高的文件，先确认词表覆盖，或先让用户
看一眼词表 revision。

## 脚本参考

| 脚本 | 用途 |
|------|------|
| `scripts/tsd_reader.py` | 主入口：环境检查、两平台解密、读取、还原、sha256 校验、输出纪律 |
| `references/environment.md` | 组件定位、缺组件提示模板、平台排障、落盘加密规则 |

排障要点：Windows 先跑 `--check`，确认 `docpermission` 不是"未找到"、`pywin32: true`；
麒麟上确认 `service_running: true`，为假时让用户正常登录桌面会话（不是纯 SSH 会话）。
