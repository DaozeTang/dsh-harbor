// Command categories: stable keys for storage, i18n strings for display.
//
// Split out of safety.js so the settings panel can render the checklist
// without pulling the command parser into the browser bundle.

/**
 * Stable identifier for the file-deletion category. The trash rewrite keys on
 * this (not on the display string) so editing the human-facing message can
 * never silently disable the rewrite.
 */
export const CATEGORY_DELETE_FILES = "删除文件或目录"; // i18n-identifier

/**
 * Category for a command whose program name is produced by shell expansion.
 *
 * Deliberately NOT in ALL_CATEGORY_KEYS: the operator's custom allow-list may
 * release a *recognized* risk (a literal delete), never the absence of a
 * decision. `a=r;b=m;$a$b -rf /` is `rm -rf /` to the shell but contains no
 * program name any pattern can match, so it always needs the operator's eyes on
 * the exact text.
 */
export const CATEGORY_UNRESOLVED_PROGRAM = "命令的实际程序名无法静态解析"; // i18n-identifier

/**
 * Machine-readable category keys. They key the operator's custom-tier allow
 * set (persisted in harbor_settings); the display strings above remain the
 * i18n surface and never travel through storage. A released category stops
 * matching its own patterns but scanning continues, so a line that also hits
 * an unreleased category stays blocked.
 */
export const ALL_CATEGORY_KEYS = Object.freeze([
  "delete-files",
  "bulk-delete",
  "db-destroy",
  "disk-format",
  "docker-destroy",
  "deploy-destroy",
  "git-destructive",
  "reboot-shutdown"
]);

/**
 * One representative display string per category key, for the operator's
 * custom-tier checklist. The strings are i18n identifiers (translated via t()
 * with existing dictionary entries); several deny-list patterns share a key,
 * and the label chosen here is the umbrella wording.
 */
// i18n-identifier-start (labels are i18n keys; the panel translates them)
export const CATEGORY_LABELS = Object.freeze({
  "delete-files": "删除文件或目录",
  "bulk-delete": "批量删除文件",
  "db-destroy": "删除数据库数据或对象",
  "disk-format": "格式化或改写磁盘",
  "docker-destroy": "删除容器、镜像或卷",
  "deploy-destroy": "销毁已部署资源",
  "git-destructive": "不可恢复地清理代码工作区",
  "reboot-shutdown": "重启或关闭服务器"
});
// i18n-identifier-end
