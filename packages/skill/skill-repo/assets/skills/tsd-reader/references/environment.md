# 环境检测与排障

`tsd_reader.py` 运行时自动检测组件，缺少关键组件会返回带 `code` 的失败结果。单独检查环境（不读文件）：

```bash
python3 scripts/tsd_reader.py --check
```

输出示例（麒麟）：

```json
{
  "platform": "linux",
  "plugin": "/usr/lib/aarch64-linux-gnu/peony-extensions/libpeony-teclink-menu.so",
  "service_running": true,
  "control_port": 10500,
  "uid": 1000
}
```

输出示例（Windows）：

```json
{
  "platform": "win32",
  "wps_home": "D:\\WPS Office\\12.8.2.21215\\office6",
  "docpermission": "D:\\WPS Office\\12.8.2.21215\\office6\\addons\\docpermission\\docpermission.dll",
  "keyservice_home": "C:\\ChinaResources\\KeyService",
  "keyservice_required": false,
  "pywin32": true
}
```

`keyservice_required: false` 是设计结论，不是"没找到"——见下文「KeyService 无关性」。

---

## 一、麒麟 / Linux —— 本地控制通道

麒麟上**不需要 WPS**：解密由桌面会话常驻的 `LSDHelper` 完成，脚本通过本地 socket 直接下指令。

| 组件 | 必需 | 自动检测 | 说明 |
|------|:----:|:--------:|------|
| `LSDHelper` | ✅ | ✅ | 登录后由桌面会话启动；未运行则一切无解 |
| `libpeony-teclink-menu.so` | ✅ | ✅ | `/usr/lib/<架构>/peony-extensions/`，**自带完整 TSD 引擎**（6895 个导出符号） |
| Python 3 + PyQt5 | ✅ | ✅ | 麒麟自带 Python 3.8.10 + PyQt5 5.15.2 |
| `xdotool` | 可选 | ✅ | 用于自动关闭结果弹窗；缺失时弹窗会留在屏幕上 |
| `pdftotext` | 仅 PDF | ✅ | poppler-utils |

**所有机器相关的参数都在运行期探测，不要硬编码**：

| 参数 | 探测方式 | 变化来源 |
|------|---------|---------|
| 插件库路径 | `glob('/usr/lib/*/peony-extensions/libpeony-teclink-menu.so')` | CPU 架构（aarch64 / x86_64） |
| 控制端口 | `ss -tlnp` 里 `LSDHelper` 那一行；取不到时 `10500 + uid % 5` | **登录用户** |
| uid | `os.getuid()` | 登录用户 |

`DISPLAY`、`LD_LIBRARY_PATH`、运行中的 peony **都不需要**。

### Linux 常见问题

| 现象 | 原因 | 处置 |
|------|------|------|
| `--check` 里 `service_running: false` | 用户未登录图形会话，或 `LSDHelper` 被结束 | 让用户正常登录桌面（不是纯 SSH 会话） |
| `plugin` 字段是错误信息 | 机器没装润文档集成 | 装润文档客户端（提供 peony 扩展） |
| `code: decrypt-failed` | 文件不是签发给当前用户的、密文已损坏，或**不是服务端签发的密文**（手工构造的 `%TSD` 头也走到这里） | 确认文件来源；换当前用户自己的文件 |
| `code: still-encrypted` | 解密后仍含 `%TSD-Header` | 通常是授权不足；不要重试，报给用户 |
| 屏幕上闪一下对话框 | `LSDHelper` 无条件弹结果框（服务端无静默开关） | 装 `xdotool`（脚本会自动关）；或让用户忽略 |
| 进程挂住不退出 | Qt 线程池清理 | 已是已知问题，脚本用 `os._exit()` 立即退出 |

### 为什么不用 WPS 打开再复制

同一条解密能力，走 GUI 有三个无法回避的问题：会占用用户屏幕、抢焦点、按键模拟在有窗口管理器的真实桌面上并不可靠；而麒麟这台机器甚至没有窗口管理器。控制通道是进程内协议调用，稳定且完全静默。

### 麒麟实测记录（真机）

| 样本 | 大小 | 结果 |
|------|------|------|
| 真实加密 docx 的副本 | 20480 B | `encrypted: true`、1449 字符 / 960 汉字、`unchanged: true`，md5 读前读后一致 |
| 探针手工构造的 `%TSD` 头 | 16384 B | `code: decrypt-failed`「解密后文件头仍是 TSD 密文」，文件被 `finally` 还原 |

结论：控制通道对**服务端签发的真实密文**有效；手工构造的头会被服务端拒。两种结局都不改磁盘内容——
成功路径读完还原，失败路径也走同一条还原分支。**不要用自造的 `%TSD` 文件判断通道是否可用。**

---

## 二、Windows —— WPS COM

| 组件 | 必需 | 自动检测 | 说明 |
|------|:----:|:--------:|------|
| WPS Office | ✅ | ✅ | 承载润文档插件的容器 |
| 润文档插件（docpermission.dll） | ✅ | ✅ | **执行解密的核心组件，只有 WPS 版本** |
| Python 3 + pywin32 | ✅ | ✅ | COM 读取用 |
| 当前用户的 SM9 密钥 | ✅ | ✅ | 文件必须发给当前用户才能解密 |
| 华润证书服务客户端（KeyService） | ❌ **不需要** | ✅ | 仅证书/密钥管理，**读取 TSD 文件无需运行** |

### KeyService 无关性（实测，v3 结论）

在 `KeyService.exe` 未运行、`127.0.0.1:10021/10022` 未监听的情况下，`KWPS.Application`
打开 TSD 加密 docx 依然拿到完整正文 **5830 字符**，与启动 KeyService 时**逐字一致**。

原因：解密由 `docpermission.dll` 插件在 WPS 进程内**内存中**完成，KeyService 只负责
证书与密钥管理，不是解密链路的一环。**不要为了让脚本读文件而启动 KeyService。**

验证方法（确认它确实没跑）：

```powershell
Get-Process -Name KeyService,WBSvr,SvrMgrApp -ErrorAction SilentlyContinue
netstat -ano | Select-String '10021|10022'   # 无输出 = 未监听
```

### WPS 三组件与 ProgID 对照（不能混用）

| 文件类型 | ProgID | 打开方式 | 正文取法 |
|---------|--------|---------|---------|
| Word (.doc/.docx) | `KWPS.Application` | `Documents.Open(path, False, True, False)` | `doc.Content.Text` |
| Excel (.xls/.xlsx) | `KET.Application` | `Workbooks.Open(path, 0, True)` | 遍历 `Worksheets` 的 `UsedRange.Value` |
| PPT (.ppt/.pptx) | `KWPP.Application` | `Presentations.Open(path, True, False, False)` | `slide.Shapes` 的 `TextFrame.TextRange.Text` |

用 Writer（`KWPS`）打开 xlsx 再另存会因格式冲突报错——读取时尤其不要串用。

### WPS Office 路径自动检测

1. 环境变量 `WPS_OFFICE_HOME` / `WPS_HOME`（指向 office6 目录）
2. 常见路径 `D:\WPS Office`、`C:\Program Files\WPS Office`、`C:\Program Files (x86)\WPS Office`
3. 取版本号最大的子目录 → 定位其下 `office6`

实测本机：`D:\WPS Office\12.8.2.21215\office6`，
插件在 `D:\WPS Office\12.8.2.21215\office6\addons\docpermission\docpermission.dll`（4.7 MB）。
注册表 `HKLM\SOFTWARE\Kingsoft\Office`、`HKCU\SOFTWARE\Kingsoft\Office` 存在，
但**版本子目录名与注册表值不一定可直接拼接**，以文件系统 glob 为准。
**版本目录名随安装版本变化，不要把它写进任何脚本。**

### 华润证书服务路径自动检测（仅用于报告，不影响读取）

1. 环境变量 `CR_KEYSERVICE_HOME`
2. 常见路径 `C:\ChinaResources\KeyService`、`D:\ChinaResources\KeyService`

### 缺少组件时的提示模板

```
缺少: 润文档插件（docpermission）
   说明: WPS 的文档权限管理插件，执行 TSD 文件解密
   安装方法:
     1. 联系公司 IT 部门获取「润文档」安装包
     2. 或从华润内部系统/润工作平台下载
     3. 安装后检查文件是否存在:
        D:\WPS Office\...\addons\docpermission\docpermission.dll
     4. 安装后重启 WPS Office
```

### Microsoft Office 无法替代 WPS

Microsoft Office 打开 TSD 文件只会看到乱码二进制数据：`docpermission.dll` 是 WPS 专属插件，
没有 Office 版本；真正执行解密的就是该插件，KeyService 不参与解密。

### Windows 常见问题

| 现象 | 原因 | 处置 |
|------|------|------|
| `--check` 里 `docpermission` 是"未找到" | 机器没装润文档插件 | 按上面模板提示用户安装 |
| `pywin32: false` | 当前 Python 没装 pywin32 | `pip install pywin32` |
| 正文中文乱码 | Windows 控制台默认 cp936 | 脚本已内部 `reconfigure(encoding="utf-8")`，无需 `chcp` |
| `encrypted: false` 但文件明明是密文 | **Python 是白名单进程**，读文件时被透明解密 | 正常现象，两条分支都已正确处理 |
| 同一文件 PowerShell 看到 `%TSD` 而 Python 看到 `PK` | 同上：PowerShell 非白名单 | 以脚本输出为准，不要据此判定文件没加密 |

### 白名单进程视角差异（重要）

实测同一批文件，**同一个瞬间**：

| 文件 | Python 视角 | PowerShell 视角 |
|------|------------|----------------|
| `enc_sample.xlsx` | `PK\x03\x04`（9846 B，明文 ZIP） | `%TSD-Header`（16384 B，密文） |
| `SMP-IT-009-01 视频监控管理规程C.docx` | `%TSD-Header`（49152 B，密文） | `%TSD-Header`（49152 B，密文） |

即：部分路径下 Python 被 TSD 安全箱**透明解密**，读到的是明文；PowerShell 读到的是密文。
两种视角脚本都要能应对——`encrypted` 字段只反映"该进程当下看到的是不是密文"，
**不代表文件的真实加密状态**。

### 落盘自动加密规则（实测）

明文写入受管位置时，**只有部分扩展名**会被安全箱重新加密：

| 写出方式 | 被加密的扩展名 | 不受影响的扩展名 |
|---------|--------------|----------------|
| PowerShell `[System.IO.File]::WriteAllText` | （本轮实测无） | txt/log/json/md/csv/tmp/dat/xml/html/py/out/plain/data/bak/tsv/yaml/ini/rst 全部保持明文 |
| Python `open(...,'w')` | `.txt`、`.xlsx`、`.py` | `.log`/`.json`/`.md`/`.csv`/`.docx` 保持明文 |

结论：明文中间文件**不是不能用，而是要用对扩展名**。`--out` 的实现据此自动纠正：
给出 `.txt`/`.xlsx`/`.py` 时会改写成 `.log`，保证 `read` 到的是明文而不是密文。
推荐直接给 `.log`。脚本内部的备份用 `.bak` 扩展名，且读完后立即删除。

### 在协作环境里怎么用（输出纪律）

`--text` 与裸 JSON 模式都会把正文写进**工具调用的输出块**。正确姿势是让正文
走「文件读取」而不是「命令输出」：

| 场景 | 命令 | 正文在哪 |
|------|------|---------|
| **取正文（首选）** | `--out <临时.log>` + `read` + 删除 | 临时文件里，经 read 进入上下文 |
| 只做校验/体检 | `--meta` | 不出现 |
| 查环境 | `--check` | 不出现 |
| 直出 stdout | `--text` | ⚠️ 会进工具输出块，尽量避免 |

三步走：

```powershell
python scripts/tsd_reader.py --out <临时文件.log> "<加密文件>"   # ① 命令输出只有路径+元数据
# ② 用 read 工具读 <临时文件.log>，完整正文原样进入上下文
Remove-Item <临时文件.log> -Force                               # ③ 立刻删除
```

不要走子代理，也不要把正文概括成要点——`read` 出来的就是原文，直接用。

---

## 安全约束（两平台共同）

1. **原文只读**：解密前备份到 `$TMPDIR`（麒麟上是 tmpfs），`finally` 里还原，属主/权限/时间戳保持一致，并比对 sha256 确认未被改写。
2. **明文只经文件读取**：正文用 `--out <临时.log>` 落文件，由宿主 `read` 进上下文，
   命令输出里不出现正文；临时文件用完立即删除。明文落到受管路径若扩展名不对会被安全箱
   重新加密（实测 `.txt` 写出即变 `%TSD` 头），故 `--out` 会自动改用 `.log`。
3. **用完即删**：备份文件在还原后立即删除。
4. **授权边界**：只能解密签发给当前用户的文件；跨用户读取会被服务端拒绝，这是设计而非缺陷。
