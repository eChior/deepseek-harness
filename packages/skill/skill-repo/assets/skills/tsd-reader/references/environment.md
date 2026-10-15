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
| `code: decrypt-failed` | 文件不是签发给当前用户的，或密文已损坏 | 确认文件来源；换当前用户自己的文件 |
| `code: still-encrypted` | 解密后仍含 `%TSD-Header` | 通常是授权不足；不要重试，报给用户 |
| 屏幕上闪一下对话框 | `LSDHelper` 无条件弹结果框（服务端无静默开关） | 装 `xdotool`（脚本会自动关）；或让用户忽略 |
| 进程挂住不退出 | Qt 线程池清理 | 已是已知问题，脚本用 `os._exit()` 立即退出 |

### 为什么不用 WPS 打开再复制

同一条解密能力，走 GUI 有三个无法回避的问题：会占用用户屏幕、抢焦点、按键模拟在有窗口管理器的真实桌面上并不可靠；而麒麟这台机器甚至没有窗口管理器。控制通道是进程内协议调用，稳定且完全静默。

---

## 二、Windows —— WPS COM

| 组件 | 必需 | 自动检测 | 说明 |
|------|:----:|:--------:|------|
| 华润证书服务客户端（KeyService） | ✅ | ✅ | 提供解密密钥，无此无法解密 |
| WPS Office | ✅ | ✅ | 承载润文档插件的容器 |
| 润文档插件（docpermission.dll） | ✅ | ✅ | **执行解密的核心组件，只有 WPS 版本** |
| 当前用户的 SM9 密钥 | ✅ | ✅ | 文件必须发给当前用户才能解密 |
| Python 3 + pywin32 | ✅ | ✅ | COM 读取用 |

### WPS Office 路径自动检测

1. 环境变量 `WPS_OFFICE_HOME`（指向 office6 目录）
2. 注册表 `HKLM\SOFTWARE\Kingsoft\Office` 和 `HKCU\SOFTWARE\Kingsoft\Office`
3. 常见路径 `D:\WPS Office`、`C:\Program Files\WPS Office` 等
4. 找到最新版本目录 → 定位 `office6` 子目录

### 华润证书服务路径自动检测

1. 环境变量 `CR_KEYSERVICE_HOME`
2. 注册表 `HKLM\SOFTWARE\ChinaResources\KeyService`
3. 常见路径 `C:\ChinaResources\KeyService`、`D:\ChinaResources\KeyService`

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

Microsoft Office 打开 TSD 文件只会看到乱码二进制数据：`docpermission.dll` 是 WPS 专属插件，没有 Office 版本；KeyService 只负责发密钥，真正执行解密的是该插件。

---

## 安全约束（两平台共同）

1. **原文只读**：解密前备份到 `$TMPDIR`（麒麟上是 tmpfs），`finally` 里还原，属主/权限/时间戳保持一致。
2. **不落普通磁盘**：明文一旦写到用户目录或桌面，会被 TSD 安全箱**重新加密**；任何中间产物只能放 tmpfs 或内存。
3. **用完即删**：备份文件在还原后立即删除。
4. **授权边界**：只能解密签发给当前用户的文件；跨用户读取会被服务端拒绝，这是设计而非缺陷。
