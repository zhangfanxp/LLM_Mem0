# LLM_Mem0 · 拾忆个人助理

一个本机运行的单人网页助理。NVIDIA NIM 负责对话生成，Mem0 Platform 云端负责长期记忆检索和自动整理；语音输入使用 Cloudflare Workers AI Whisper，语音输出使用 Microsoft Edge 在线语音。

## 功能

- 选择 NVIDIA NIM 模型进行中文对话，回答以流式文字显示。
- 对话前从 Mem0 检索相关记忆，并将本轮对话提交给 Mem0 自动提取长期记忆。
- 查看、搜索、逐条删除或清空 Mem0 长期记忆，也可以手动将某条聊天内容原文保存为记忆。
- 聊天记录和所选模型保存在当前浏览器的 `localStorage`；“新对话”只清除本地聊天显示，不删除 Mem0 记忆。
- 点击麦克风开始录音，再点一次结束。Cloudflare Whisper 转写后自动提交给助理；回答文字流式显示，语音按句合成并连续播放。也可以手动重播回答。
- 语音合成前会清理 Markdown 格式标记，避免读出粗体星号、列表符号等；网页中的原始回答保持不变。
- 默认 Nemotron 推理强度为 `low`，以减少首字等待。可在 `.env` 中设为 `high`，让模型进行更充分的推理。

## 环境要求

- Python 3.10 或更新版本
- [uv](https://docs.astral.sh/uv/)
- NVIDIA NIM、Mem0 Platform 和 Cloudflare Workers AI 的 API 凭据

## 安装和启动

1. 克隆项目并进入项目目录。

   ```sh
   git clone <GitHub 仓库地址>
   cd LLM_Mem0
   ```

2. 创建本机配置文件，并填写 API 凭据。

   ```sh
   cp .env.example .env
   ```

   在 `.env` 中填写 `NVIDIA_API_KEY`、`MEM0_API_KEY`、`CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。Cloudflare API Token 需要 Workers AI 权限。`.env` 不会提交到 Git。

3. 同步依赖。`uv.lock` 会锁定实际解析的依赖版本。

   ```sh
   uv sync --locked
   ```

4. 启动应用。

   ```sh
   uv run server.py
   ```

   也可以运行 `sh run.sh`。浏览器打开 <http://127.0.0.1:5001>。默认端口由 `.env` 中的 `PORT` 控制；停止服务时按 `Ctrl+C`。

## 配置项

| 配置 | 用途 | 默认值 |
| --- | --- | --- |
| `NVIDIA_API_KEY` | NVIDIA NIM 对话 API | 必填 |
| `MEM0_API_KEY` | Mem0 Platform 长期记忆 | 必填 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI 账户 | 语音识别必填 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI Token | 语音识别必填 |
| `NVIDIA_DEFAULT_MODEL` | 默认 NVIDIA 模型 | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| `NVIDIA_REASONING_EFFORT` | Nemotron 推理强度：`none`、`low` 或 `high` | `low` |
| `MEM0_USER_ID` | Mem0 用户隔离标识 | `personal-assistant` |
| `PORT` | 本机网页服务端口 | `.env.example` 中为 `5001` |
| `TTS_VOICE` | Microsoft Edge 语音名称 | `zh-CN-XiaoxiaoNeural` |

Mem0 V3 自动处理是异步的，回答成功不代表记忆已经整理完成。当前策略主要新增记忆；矛盾或过时的记忆可在记忆库中手动删除。

## 语音和网络访问

浏览器录音需要麦克风权限。本机电脑通过 `localhost` 访问时可以使用；手机浏览器需要 HTTPS。应用默认只监听 `127.0.0.1`，因此手机访问还需要由用户自行配置可访问的 HTTPS 反向代理或隧道。

语音录音不会保存到应用本机。录音会发送到 Cloudflare 转写；回答文本会发送到 Microsoft Edge 在线语音服务合成。`edge-tts` 是社区客户端，该服务接口并非微软承诺稳定的公开 API。

## 隐私

- API Key 存放在项目根目录 `.env`，不会发送到浏览器；`.env` 已加入 `.gitignore`。
- 聊天正文发送到 NVIDIA 生成回答，并发送到 Mem0 云端进行记忆检索和自动整理。
- 长期记忆保存在 Mem0 云端；聊天历史只保存在当前浏览器的 `localStorage`。
- 不要输入密码、API Key、验证码或其他不希望交给上述服务处理的信息。

## 项目文件

- `server.py`：本机 HTTP 服务以及 NVIDIA、Mem0、Cloudflare 和 TTS 调用
- `web/`：单页网页应用
- `pyproject.toml`：项目元数据和直接依赖
- `uv.lock`：锁定的依赖版本
- `.env.example`：本机配置模板
