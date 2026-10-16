# 更新日志

## 3.0.0 — 2026-10-16

**两平台合成一份，正文只经「文件读取」进入会话。**

- `scripts/tsd_reader.py`：同一个入口按 `platform` 分派——Windows → WPS COM
  （`KWPS`/`KET`/`KWPP`，解密由 `docpermission.dll` 在 WPS 进程内存里完成），
  麒麟 → `LSDHelper` 本地控制通道。调用方只需记一条命令，不必再分两份装。
- **正文不再默认打印**：取正文一律走 `--out <临时文件.log>`，命令输出里只有路径与元数据；
  宿主 `read` 该文件后立刻删除。`--text` 与裸 JSON 会把全文刷进工具结果块，
  只在没有文件读取手段时才用。
- `--out` 自动纠正扩展名：`.txt`/`.xlsx`/`.py` 会被安全箱二次加密，脚本改写为 `.log`，
  保证 `read` 到的是明文。
- `SKILL.md` 新增「输出纪律」与「与脱敏插件配合」两节：正文经 `read` 进入会话时由
  `redaction` 插件换成占位符；两条不能做的事——用 `--text`/裸 JSON 图省事、把正文概括成
  要点再复述（assistant 输出不走脱敏，挂点只在入站与工具结果上）。
- Windows 侧新增实测结论：**不需要 KeyService**（`KeyService.exe`/`WBSvr.exe`/
  `SvrMgrApp.exe`/`CertMgr.exe` 全部杀掉后仍能读出完整正文、原文 sha256 不变）；
  同一批文件下 **Python 可能是白名单进程**，读到的是明文而 PowerShell 读到的是密文，
  `encrypted: false` 不代表文件没加密。
- `references/environment.md`：补齐两平台的 `--check` 样例；写入麒麟真机端到端实测记录
  （真实密文 docx 读出 1449 字符 / 960 汉字、`unchanged: true`、md5 读前读后一致；
  手工构造的 `%TSD` 头被服务端拒绝并原样还原）。

## 2.1.0

麒麟侧改用 `LSDHelper` 本地控制通道：就地解密 → 读文本 → `finally` 还原，
不再驱动 GUI、不模拟按键、不依赖 `DISPLAY` 与 `LD_LIBRARY_PATH`。

## 1.x

Windows 侧实现：`pywin32` 驱动 WPS COM，解密由 `docpermission.dll` 在 WPS 进程内完成，
磁盘原文件始终保持 `%TSD` 密文。
