# opencode-sound-notify

OpenCode 插件：在会话事件触发时播放提示音，让用户无需盯着屏幕也能感知状态变化。

## 安装

```bash
npm install @xiaoqiong0v0/opencode-sound-notify
```

在 `opencode.json` 中添加：

```json
{
  "plugin": ["@xiaoqiong0v0/opencode-sound-notify"]
}
```

## 配置

首次加载自动生成配置文件 `~/.config/opencode/sound-notify.jsonc`：

```jsonc
{
  // 默认提示音文件路径，留空使用内置 default.wav
  "sound": "",
  // 按事件单独指定提示音路径，key=事件名，value=wav 文件路径
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
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `sound` | 内置 `assets/default.wav` | 默认 .wav 路径 |
| `sounds` | `{}` | 按事件单独配置，key=事件名，value=wav 路径 |
| `events` | `["session.idle", "session.error", "permission.asked"]` | 触发事件列表 |
| `defaultDebounceMs` | `30000` | 全局默认防抖间隔 |
| `minIntervalMs` | `3000` | 全局最小间隔，所有声音不能小于此值，设为 0 关闭 |
| `debounceMs` | `{}` | 按事件单独配置，key=事件名，value=防抖间隔(ms) |
| `lang` | `"en"` | 语言设置 |
| `enabled` | `true` | 总开关 |

内置音频对应关系：

| 事件 | 内置文件 | 音效 |
|------|----------|------|
| `session.idle` | `assets/default.wav` | 默认 |
| `session.error` | `assets/error.wav` | 短促蜂鸣 |
| `permission.asked` | `assets/ask.wav` | 双音提醒 |

## 支持的事件

| 事件 | 说明 |
|------|------|
| `session.idle` | 会话空闲（任务完成） |
| `session.error` | 会话出错 |
| `permission.asked` | 权限询问 |
| `session.created` | 新会话创建 |
| `session.updated` | 会话更新 |
| `session.status` | 会话状态变更 |

## 运行时开关

通过 AI 对话即可开关声音（不写配置，重启恢复）：

- `关掉声音` / `mute` — 静音
- `开启声音` / `unmute` — 恢复
- `声音开关` / `toggle` — 切换

## 平台支持

| 平台 | 播放方式 |
|------|----------|
| Windows | PowerShell SoundPlayer |
| macOS | `afplay` |
| Linux | `paplay` (PulseAudio) / `aplay` (ALSA) |
