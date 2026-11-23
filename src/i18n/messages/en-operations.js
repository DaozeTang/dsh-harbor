
/**
 * English wording added by the operations surface. Keys are the Chinese source
 * literals t() receives; see core.js.
 *
 * The status monitor lives here: one card vocabulary shared by the panel and
 * the copied snapshot, plus the host-side sampling messages.
 */
export const en = {
  // ── status pane: card titles and labels ──────────────────────────────────
  "状态": "Status",
  "CPU": "CPU",
  "GPU": "GPU",
  "内存": "Memory",
  "磁盘": "Disks",
  "网络": "Network",
  "进程": "Processes",
  "连接": "Connection",
  "负载": "Load",
  "核心": "Cores",
  "核": "cores",
  "每核占用": "Usage per core",
  "显存": "VRAM",
  "已用": "Used",
  "缓存": "Cache",
  "未启用": "Not enabled",
  "读写": "I/O",
  "读": "Read",
  "写": "Write",
  "挂载于": "mounted at",
  "磁盘读写": "Disk I/O",
  "服务器": "Server",
  "地址": "Address",
  "本对话终端": "Terminals here",
  "采样": "Sampled",
  "采样往返": "Sample round trip",
  "采样间隔": "Sampling interval",
  "线程": "Threads",
  "运行中": "Running",
  "按 CPU 排序": "By CPU",
  "在线": "Up",

  // ── status pane: state, actions and empty/error copy ─────────────────────
  "正在采样…": "Sampling…",
  "已暂停": "Paused",
  "暂停采样": "Pause sampling",
  "继续采样": "Resume sampling",
  "刷新": "Refresh",
  "重试": "Retry",
  "复制快照": "Copy snapshot",
  "快照已复制": "Snapshot copied",
  "复制失败，请手动选择文本。": "Copy failed; select the text manually.",
  "这台设备暂不支持状态采集": "Status sampling is not supported on this host",
  "切到终端查看": "Open the terminal",
  "这台设备没有可用的 POSIX shell（exec 通道），读不到系统状态。网络设备（VRP / Comware 这类）属于此列。": "This host has no POSIX shell on the exec channel, so system status cannot be read. Network devices (VRP / Comware and similar) are in this group.",
  "这台设备不是 Linux 主机（${sample.platformName ?? \"unknown\"}），状态采集暂不支持。": "This host is not Linux (${sample.platformName ?? \"unknown\"}), so status sampling is not supported.",
  "这台设备上读不到 /proc 数据，状态采集暂不支持。": "No /proc data could be read on this host, so status sampling is not supported.",
  "远端输出不完整，部分指标可能缺失。": "The remote output was incomplete; some metrics may be missing.",
  "采样输出被截断，指标可能缺失。": "The sample output was truncated; some metrics may be missing.",
  "采样间隔尚未完成，占用率与速率稍后出现。": "The first sampling interval has not finished; usage and rates appear shortly.",
  "没有可读取的挂载点。": "No readable mount points.",
  "没有网络接口数据。": "No network interface data.",
  "这台设备的 ps 读不到进程占用。": "This host's ps does not report per-process usage.",
  "进程 CPU 占比是生命周期平均（ps），不是瞬时值。": "Process CPU is a lifetime average from ps, not an instantaneous value.",
  "CPU 占用趋势": "CPU usage trend",
  "接收速率趋势": "Receive rate trend",

  // ── uptime, from the formatter ───────────────────────────────────────────
  "${total} 秒": "${total}s",
  "${Math.floor(total / 60)} 分钟": "${Math.floor(total / 60)}m",
  "${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分": "${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m",
  "${Math.floor(total / 86400)} 天 ${Math.floor((total % 86400) / 3600)} 小时": "${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h",

  // ── settings: the two switches this feature adds ─────────────────────────
  "系统状态工具": "System status tool",
  "读取 CPU、内存、磁盘、网络与 GPU 状态": "Read CPU, memory, disk, network and GPU status",

  // ── host-side sampling messages ──────────────────────────────────────────
  "连接已断开，正在等待重连；链路恢复后状态会自动继续。": "The connection is down and reconnecting; sampling resumes automatically once the link is back.",
  "采样过程中连接断开，请稍后重试。": "The connection dropped during sampling; try again shortly.",
  "状态采样超时（4 秒），这台服务器可能没有响应；稍后会自动重试。": "Status sampling timed out after 4 seconds; the server may not be responding. It will retry automatically.",
  "采样暂停，${seconds} 秒后自动重试": "Sampling paused, retrying automatically in ${seconds}s",
  "状态采样失败：${error?.message ?? String(error)}": "Status sampling failed: ${error?.message ?? String(error)}",
  "状态采样结果无法解析：${error?.message ?? String(error)}": "The status sample could not be parsed: ${error?.message ?? String(error)}"
};
