---
name: qq-speech
description: 在当前 QQ Codex 对话中转写已有语音、朗读文字或生成语音回复。用户明确要求转写、朗读或语音回复时使用；收到语音本身不要求用语音回复，已提供的转写不重复识别。
license: MIT
---

# QQ 语音（Codex）

使用本轮实际的 `qq_status`、`qq_speech` 和 `qq_send_media`。转换与 QQ 发送是两步，不执行其他机器人的 CLI 或平台接口。

## 先判断本轮需求

入口已提供语音识别文字时，直接处理文字。确需转换时先查 `qq_status.speech` 的 `available` 与 `authorizedForCurrentRequest`；未配置或本轮未授权则如实说明，不能换路由绕过。

- 转写：`qq_speech({"action":"stt","path":"实际工作区音频路径","language":"auto"})`。语言支持 `auto` 或小写两至三字母代码，如 `zh`、`en`。读取实际 `transcript`；空文本或中文同音误识别不擅自补全，关键姓名、金额等不确定时再确认。
- 合成：`qq_speech({"action":"tts","text":"要朗读的正文"})`。也可先把正文写入工作区 UTF-8 文件，再传 `path`；二者选其一。当前工具没有 voice 或音色选择参数，不编造设置。
- 用户要求把声音发回 QQ 时，把成功返回的真实音频 `path` 交给 `qq_send_media({"kind":"voice","path":"返回的实际路径"})`。`createsMessage:false` 表示转换本身没有发消息。

文件必须实际存在且在当前工作区内，最多 16 MiB；识别音频最多 120 秒，合成正文最多 1500 字符。超出时说明限制，按用户意图分段，不静默截断，也不自行追加大量发送。

转换失败或超时不自动重试，防止重复处理。平台发送只有真实 `messageId` 且 `acknowledged:true` 才能确认已接收；尚未确认时不能声称已发出或自动改成文件重发。需要用户同意改发音频文件时，再用 `kind:"file"`。

已有工具发送成功后，最终回复不重复输出媒体标记。媒体发送预算和其他细节见 `../qqbot-media/SKILL.md`；不读取或展示服务密钥。
