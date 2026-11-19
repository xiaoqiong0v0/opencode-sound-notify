import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger"

const CONFIG_DIR = process.env.HOME || process.env.USERPROFILE || ""
const CONFIG_PATH = join(CONFIG_DIR, ".config/opencode", "sound-notify.jsonc")

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ASSET_DIR = join(__dirname, "..", "assets")
const DEFAULT_SOUND = join(ASSET_DIR, "default.wav")

// 事件 → 内置音频文件映射
const BUILTIN_SOUNDS: Record<string, string> = {
  "session.idle": "default.wav",
  "session.error": "session.error.wav",
  "permission.asked": "permission.asked.wav",
}

// Termux 默认前缀目录
const TERMUX_PREFIX = "/data/data/com.termux/files/usr"

const log: Logger = createLogger("sound-notify")

const SAMPLE_CFG = `{
  // 默认提示音文件路径，留空使用内置 default.wav
  "sound": "",
  // 按事件单独指定提示音路径，key=事件名，value=wav文件路径
  // 留空则使用默认 sound
  "sounds": {
    "session.error": "",
    "permission.asked": ""
  },
  // 触发提示音的事件列表
  "events": ["session.idle", "session.error", "permission.asked"],
  // 全局默认防抖间隔(ms)，未单独配置的事件使用此值
  "defaultDebounceMs": 30000,
  // 全局最小间隔(ms)，所有声音播放不能低于此间隔，覆盖单独配置
  "minIntervalMs": 3000,
  // 按事件单独配置防抖间隔(ms)，覆盖 defaultDebounceMs
  "debounceMs": {
    "permission.asked": 5000
  },
  // 子任务(sub-session)中仍触发提示音的事件列表，默认仅权限请求
  "childEvents": ["permission.asked"],
  // Termux 音频流类型，仅 Termux 生效（media/alarm/notification/ring/system/voice）
  "streamType": "media",
  // 语言: "zh" 或 "en"
  "lang": "en",
  // 是否启用
  "enabled": true
}
`

interface Cfg {
  sound?: string
  sounds?: Record<string, string>
  events?: string[]
  minIntervalMs?: number
  defaultDebounceMs?: number
  debounceMs?: Record<string, number>
  childEvents?: string[]
  streamType?: string
  enabled?: boolean
}

interface TxEntry { zh: string; en: string }

let LANG: "zh" | "en" = "en"

let muted = false

const TX: Record<string, TxEntry> = {
  init_failed:           { zh: "初始化失败，使用默认配置", en: "Init failed, using defaults" },
  play_error:            { zh: "播放失败", en: "Playback failed" },
  unsupported_platform:  { zh: "不支持的播放平台: {platform}", en: "Unsupported platform: {platform}" },
  no_sound_file:         { zh: "声音文件不存在: {path}", en: "Sound file not found: {path}" },
  muted_on:              { zh: "声音已关闭", en: "Sound muted" },
  muted_off:             { zh: "声音已开启", en: "Sound unmuted" },
  mute_desc:             { zh: "控制提示音开关：action=on 开启，action=off 关闭，action=toggle 切换", en: "Control notification sound: action=on to enable, action=off to disable, action=toggle to switch" },
  mute_template:         { zh: "用户想要切换声音状态。调用 sound_toggle 工具，action 参数：on=开启，off=关闭，toggle=切换。", en: "User wants to control sound. Call sound_toggle tool: action=on to enable, action=off to disable, action=toggle to switch." },
  mute_action:           { zh: "on 开启 off 关闭 toggle 切换", en: "on enable off disable toggle switch" },
  mute_save:             { zh: "save=true 同时写入配置文件持久化", en: "save=true also persist to config file" },
  save_ok:               { zh: "已保存到配置文件 {path}", en: "Saved to config {path}" },
  save_fail:             { zh: "保存失败: {msg}", en: "Save failed: {msg}" },
  termux_no_player:      { zh: "Termux 未找到 play-audio，请先执行: pkg install play-audio", en: "play-audio not found in Termux, install it: pkg install play-audio" },
}

const T = (key: string, params?: Record<string, string>): string => {
  const entry = TX[key] || { zh: key, en: key }
  const t = LANG === "zh" ? entry.zh : entry.en
  if (!params) return t
  return Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t)
}

let cfg: Cfg = {}

function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf-8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  return JSON.parse(raw)
}

function loadCfg(): void {
  if (!existsSync(CONFIG_PATH)) {
    const dir = dirname(CONFIG_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(CONFIG_PATH, SAMPLE_CFG, "utf-8")
  }
  const raw = readJsonc(CONFIG_PATH)
  cfg = {
    sound: (raw.sound as string) || "",
    sounds: raw.sounds as Record<string, string> | undefined,
    events: raw.events as string[] | undefined,
    minIntervalMs: (raw.minIntervalMs as number) ?? 3000,
    defaultDebounceMs: (raw.defaultDebounceMs as number) || 30000,
    debounceMs: raw.debounceMs as Record<string, number> | undefined,
    childEvents: (raw.childEvents as string[]) || ["permission.asked"],
    streamType: (raw.streamType as string) || "media",
    enabled: raw.enabled !== false,
  }
  LANG = (raw.lang as string) === "zh" ? "zh" : "en"
}

function persistEnabled(enabled: boolean): void {
  if (!existsSync(CONFIG_PATH)) return
  const raw = readFileSync(CONFIG_PATH, "utf-8")
  const updated = raw.replace(/"enabled"\s*:\s*(true|false)/, `"enabled": ${enabled}`)
  writeFileSync(CONFIG_PATH, updated, "utf-8")
}

try { loadCfg() } catch (e: unknown) {
  log.error(T("init_failed"), e instanceof Error ? e : Error(String(e)))
}

const eventTimestamps = new Map<string, number>()
const subSessions = new Set<string>()
let globalLastPlay = 0

// idle 提示音延迟(ms)：延迟期内若出现新输入则取消播放
const IDLE_DELAY_MS = 500
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleSessionId: string | undefined
let idleUserId: string | undefined
let lastUserId: string | undefined

// 取消待播放的 idle 提示音
function cancelIdle(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

// 延迟播放 idle 提示音，等待期间可被新输入取消
function scheduleIdle(sid: string | undefined): void {
  cancelIdle()
  idleSessionId = sid
  idleUserId = lastUserId
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (shouldPlay("session.idle")) {
      play("session.idle")
    } else {
      log.info(`idle skipped: ${blockReason("session.idle")}`)
    }
  }, IDLE_DELAY_MS)
}

// 判断事件是否表示同一会话出现新的用户输入/活动
function isNewInput(type: string, properties: Record<string, unknown> | undefined, sid: string | undefined): boolean {
  if (!idleTimer || sid !== idleSessionId) return false
  if (type === "session.status") {
    const status = properties?.status as { type?: string } | undefined
    return status?.type === "busy"
  }
  if (type === "message.updated") {
    const info = properties?.info as { role?: string; id?: string } | undefined
    // 仅当出现“新的用户消息”才算新输入；旧消息的重复推送不算
    return info?.role === "user" && !!idleUserId && !!info.id && info.id !== idleUserId
  }
  return false
}

// 判断是否运行在 Termux(Android) 环境
function isTermux(): boolean {
  return process.platform === "android"
    || !!process.env.TERMUX_VERSION
    || (process.env.PREFIX || "").includes("com.termux")
}

// 查找 Termux 内的命令绝对路径，找不到返回 null
function findTermuxBin(name: string): string | null {
  const prefix = process.env.PREFIX || TERMUX_PREFIX
  const p = join(prefix, "bin", name)
  return existsSync(p) ? p : null
}

function getPlayerArgs(sound: string): string[] | null {
  if (isTermux()) {
    const player = findTermuxBin("play-audio")
    if (!player) return null
    const streamArgs = cfg.streamType ? ["-s", cfg.streamType] : []
    return [player, ...streamArgs, sound]
  }
  switch (process.platform) {
    case "win32":
      return ["powershell", "-NoProfile", "-Command",
        `(New-Object System.Media.SoundPlayer '${sound.replace(/'/g, "''")}').PlaySync()`]
    case "darwin":
      return ["afplay", sound]
    case "linux": {
      if (existsSync("/usr/bin/paplay")) return ["paplay", sound]
      if (existsSync("/usr/bin/aplay")) return ["aplay", sound]
      return null
    }
    default:
      return null
  }
}

function resolveSound(eventType: string): string {
  const custom = cfg.sounds?.[eventType]
  if (custom && existsSync(custom)) return custom
  if (cfg.sound && existsSync(cfg.sound)) return cfg.sound
  const file = BUILTIN_SOUNDS[eventType] || `${eventType}.wav`
  const builtin = join(ASSET_DIR, file)
  if (existsSync(builtin)) return builtin
  return DEFAULT_SOUND
}

function play(eventType: string): Promise<boolean> {
  const path = resolveSound(eventType)
  if (!existsSync(path)) {
    log.error(T("no_sound_file", { path }))
    return Promise.resolve(false)
  }
  const args = getPlayerArgs(path)
  if (!args) {
    log.error(isTermux() ? T("termux_no_player") : T("unsupported_platform", { platform: process.platform }))
    return Promise.resolve(false)
  }
  const [cmd, ...cmdArgs] = args
  const ps = spawn(cmd, cmdArgs, { stdio: "ignore", windowsHide: true })
  return new Promise((resolve) => {
    ps.on("error", (err) => { log.error(T("play_error"), err); resolve(false) })
    ps.on("close", (code) => { resolve(code === 0) })
  })
}

// 返回播放被拦截的原因，null 表示允许播放
function blockReason(eventType: string): string | null {
  if (muted) return "muted"
  if (!cfg.enabled) return "disabled"
  if (!cfg.events?.includes(eventType)) return "not-in-events"

  const now = Date.now()
  const minMs = cfg.minIntervalMs || 0
  const debounceMs = cfg.debounceMs?.[eventType] ?? cfg.defaultDebounceMs ?? 30000
  const effective = minMs > debounceMs ? minMs : debounceMs

  // 全局间隔检查：任何声音播放后 minIntervalMs 内都不再响应
  if (minMs > 0 && now - globalLastPlay < minMs) return `global-interval(${now - globalLastPlay}<${minMs})`

  const last = eventTimestamps.get(eventType) || 0
  if (now - last < effective) return `debounce(${now - last}<${effective})`
  return null
}

function shouldPlay(eventType: string): boolean {
  if (blockReason(eventType)) return false
  const now = Date.now()
  eventTimestamps.set(eventType, now)
  globalLastPlay = now
  return true
}

export const SoundNotify = async () => {
  log.loaded()
  return {
    config: async (config: Record<string, unknown>) => {
      log.hook("config", "register command sound-toggle")
      try {
        const commands = (config.command as Record<string, unknown>) ?? {}
        commands["sound-toggle"] = {
          description: T("mute_desc"),
          template: T("mute_template"),
        }
        config.command = commands
        log.info("sound-toggle command registered")
      } catch (e: unknown) {
        log.error("command registration failed", e instanceof Error ? e : Error(String(e)))
      }
    },
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info as Record<string, unknown> | undefined
        if (info?.parentID) subSessions.add(info.id as string)
        return
      }
      const sid = event.properties?.sessionID as string | undefined
      if (sid && subSessions.has(sid) && !cfg.childEvents?.includes(event.type)) return

      // 记录最新的用户消息 id，用于区分“新消息”与“旧消息的重复推送”
      if (event.type === "message.updated") {
        const info = event.properties?.info as { role?: string; id?: string } | undefined
        if (info?.role === "user" && info.id) lastUserId = info.id
      }

      // 新输入/活动 → 取消尚未播放的 idle 提示音
      if (isNewInput(event.type, event.properties, sid)) {
        log.info(`idle canceled by ${event.type}`)
        cancelIdle()
      }

      // idle 延迟播放，延迟期内出现新输入则不响
      if (event.type === "session.idle") {
        scheduleIdle(sid)
        return
      }
      if (shouldPlay(event.type)) play(event.type)
    },
    tool: {
      sound_toggle: tool({
        description: T("mute_desc"),
        args: {
          action: tool.schema.enum(["on", "off", "toggle"]).describe(T("mute_action")),
          save: tool.schema.boolean().optional().describe(T("mute_save")),
        },
        execute: async ({ action, save }: { action: "on" | "off" | "toggle"; save?: boolean }) => {
          if (action === "on") {
            muted = false
            cfg.enabled = true
          } else if (action === "off") {
            muted = true
          } else if (action === "toggle") {
            muted = !muted
          }
          if (save) {
            try {
              persistEnabled(!muted)
              cfg.enabled = !muted
              return T(muted ? "muted_on" : "muted_off") + " | " + T("save_ok", { path: CONFIG_PATH })
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e)
              log.error(T("save_fail", { msg }))
              return T("save_fail", { msg })
            }
          }
          return T(muted ? "muted_on" : "muted_off")
        },
      }),
    },
  }
}

export default SoundNotify
