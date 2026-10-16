# 更新日志

## 3.0.0 — 2026-10-16

**两平台合并成一份，并把"正文不进工具输出"变成默认行为。**

- `scripts/tsd_reader.py`：原来 Windows 版里已经内置了麒麟的控制通道实现，现在正式按
  `platform` 分派——Windows → WPS COM（`KWPS`/`KET`/`KWPP`），麒麟 → `LSDHelper`
  本地控制通道。调用方只需记一条命令，不必再分两份装。
- **默认不再把正文写进工具输出**：不指定 `--out` 时脚本自己把正文写进临时文件
  （麒麟 `/tmp` 是 tmpfs，Windows 是 `%TEMP%`），stdout 只剩路径与元数据；
  临时文件写完即设为 `0600`。
- 删掉原来的裸 JSON 输出模式——它会连正文一起打印。直出只剩显式的 `--text`。
- `SKILL.md` 新增「与脱敏插件配合」：说明正文经 `read` 进入会话时由 `redaction` 插件换成
  占位符，以及两条不能做的事：用 `--text` 图省事、把正文概括成要点再复述
  （assistant 输出不走脱敏）。
- `references/environment.md`：补齐两平台的 `--check` 样例；修正 Windows 侧的字段名与
  实测版本路径；写入麒麟端到端实测记录——真实密文 docx 读出 1449 字符 / 960 汉字，
  `unchanged: true`，md5 读前读后一致。

## 2.1.0

麒麟侧改用 `LSDHelper` 本地控制通道：就地解密 → 读文本 → `finally` 还原，
不再驱动 GUI、不模拟按键、不依赖 `DISPLAY` 与 `LD_LIBRARY_PATH`。

## 1.x

Windows 侧实现：`pywin32` 驱动 WPS COM，解密由 `docpermission.dll` 在 WPS 进程内完成，
磁盘原文件始终保持 `%TSD` 密文。
