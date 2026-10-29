/** Copy for the skill publishing tab. */
export const zh = {
  tab: '技能上传',
  intro: '把本机的技能发布到部门的技能仓库。上传只新增文件：仓库里已经存在且内容不同的文件不会被覆盖。',
  departmentHint: '技能会落在 departments/<你的部门>/ 下。其他同事在技能管理器里按需选择安装，不会被强制同步。',
  unavailable: '这台机器没有安装技能仓库插件，无法上传。',
  loading: '读取中…',
  empty: '本机技能目录里没有可上传的技能。',
  refresh: '刷新',
  upload: '上传',
  uploading: '上传中…',
  files: '共 {count} 个文件',
  written: '已上传 {count} 个文件',
  unchanged: '{count} 个文件已存在且内容相同',
  conflicts: '{count} 个文件与仓库里的不同，未覆盖',
  skipped: '{count} 个文件超过单次上传上限，已跳过',
  failed: '上传失败：{reason}',
  loadFailed: '读取技能失败：{reason}',
}

/** Copy for the skill publishing tab. */
export const en = {
  tab: 'Skill upload',
  intro: 'Publish a skill from this machine into the department skill repository. Uploading only adds files: a repository file that exists with different contents is never overwritten.',
  departmentHint: 'Skills land under departments/<your department>/. Colleagues install them from the skills manager when they want them; nothing is synced by force.',
  unavailable: 'The skill repository plugin is not installed on this machine, so nothing can be published.',
  loading: 'Reading…',
  empty: 'No skill in the local skills directory can be published.',
  refresh: 'Refresh',
  upload: 'Upload',
  uploading: 'Uploading…',
  files: '{count} files',
  written: '{count} files uploaded',
  unchanged: '{count} files already matched',
  conflicts: '{count} files differ from the repository and were left alone',
  skipped: '{count} files were too large for one request and were skipped',
  failed: 'Upload failed: {reason}',
  loadFailed: 'Reading the skills failed: {reason}',
}

/** Every copy string the skills tab renders. */
export type SkillUploadLocaleKey = keyof typeof zh
