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
  enabled?: boolean
}

interface TxEntry { zh: string; en: string }

let LANG: "zh" | "en" = "en"

const TX: Record<string, TxEntry> = {
  init_failed:           { zh: "初始化失败，使用默认配置", en: "Init failed, using defaults" },
  play_error:            { zh: "播放失败", en: "Playback failed" },
  unsupported_platform:  { zh: "不支持的播放平台: {platform}", en: "Unsupported platform: {platform}" },
  no_sound_file:         { zh: "声音文件不存在: {path}", en: "Sound file not found: {path}" },

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
    enabled: raw.enabled !== false,
  }
  LANG = (raw.lang as string) === "zh" ? "zh" : "en"
}

try { loadCfg() } catch (e: unknown) {
  log.error(T("init_failed"), e instanceof Error ? e : Error(String(e)))
}

const eventTimestamps = new Map<string, number>()
let globalLastPlay = 0

function getPlayerArgs(sound: string): string[] | null {
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
  const builtin = join(ASSET_DIR, `${eventType === "session.idle" ? "default" : eventType.replace("session.", "")}.wav`)
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
    log.error(T("unsupported_platform", { platform: process.platform }))
    return Promise.resolve(false)
  }
  const [cmd, ...cmdArgs] = args
  const ps = spawn(cmd, cmdArgs, { stdio: "ignore", windowsHide: true })
  return new Promise((resolve) => {
    ps.on("error", (err) => { log.error(T("play_error"), err); resolve(false) })
    ps.on("close", (code) => { resolve(code === 0) })
  })
}

function shouldPlay(eventType: string): boolean {
  if (!cfg.enabled) return false
  if (!cfg.events?.includes(eventType)) return false

  const now = Date.now()
  const minMs = cfg.minIntervalMs || 0
  const debounceMs = cfg.debounceMs?.[eventType] ?? cfg.defaultDebounceMs ?? 30000
  const effective = minMs > debounceMs ? minMs : debounceMs

  // 全局间隔检查：任何声音播放后 minIntervalMs 内都不再响应
  if (minMs > 0 && now - globalLastPlay < minMs) return false

  const last = eventTimestamps.get(eventType) || 0
  if (now - last < effective) return false
  eventTimestamps.set(eventType, now)
  globalLastPlay = now
  return true
}

export const SoundNotify = async () => {
  log.loaded()
  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (shouldPlay(event.type)) {
        play(event.type)
      }
    },
  }
}
