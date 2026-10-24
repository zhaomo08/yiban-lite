# 译伴 Lite

用**本地翻译小模型**给 YouTube 加双语字幕、给网页加对照译文的 Chrome 扩展（Manifest V3）。
文本只发往你自己机器或局域网里的模型（Ollama、LM Studio、llama.cpp 等），不经过任何云端服务，无账号。

推荐搭配腾讯混元的 **Hy-MT2-1.8B**：约 1.1GB，在 Apple M1 上每句 0.3–0.7 秒，中英日韩德等方向质量都不错。

## 功能

- **YouTube 双语字幕**：截获 YouTube 播放器自己请求的字幕时间轴，提前翻译后面的字幕，播放到时译文已就绪；拿不到时间轴时实时翻译屏幕上的 CC。
- **没有 CC 的视频（可选）**：配合 `server/asr.py` 用 mlx-whisper 整片转写，从当前播放位置开始逐段出字幕（需 Apple Silicon，见下文）。
- **网页对照翻译**：逐段在原文下方插入译文，随滚动加载，一键恢复原文。
- **字幕样式**：字号、位置拖动即时预览，保存后生效。

## 快速开始

### 1. 准备模型（Ollama）

```bash
ollama pull kaelri/hy-mt2:1.8b-q4_K_M
```

Ollama 默认拒绝浏览器扩展的请求，需要允许扩展来源后**重启 Ollama**：

```bash
# macOS（Ollama 桌面版）
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# Linux（systemd）：systemctl edit ollama，加入 Environment="OLLAMA_ORIGINS=chrome-extension://*"
# Windows：在系统环境变量里新增 OLLAMA_ORIGINS=chrome-extension://*
```

> macOS 的 `launchctl setenv` 重启电脑后失效。也可以不改 Ollama，改用下文的「连接助手」。

### 2. 安装扩展

```bash
npm install
npm run build
```

Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择**项目根目录**（`dist/` 也可以）。

### 3. 配置并使用

1. 点工具栏的「译伴 Lite」→「模型连接」：协议选 Ollama，Base URL `http://127.0.0.1:11434`，模型名填刚才拉取的名字，提示词选「HY-MT 专用」。
2. 点「保存模型设置」，在 Chrome 授权框里允许访问该地址，再点「测试翻译」确认。
   （授权框会把弹窗关掉，重新打开弹窗时填写内容会自动恢复，再点一次即可。）
3. 打开 YouTube 视频，在弹窗「翻译」页打开「双语字幕」；普通网页点「翻译当前网页」。

## 推荐的本地翻译小模型

| 模型 | 体积 | 语言 | 获取方式 | 提示词方式 | 说明 |
|---|---|---|---|---|---|
| **Hy-MT2-1.8B**（腾讯混元，2026-05） | ~1.1GB（Q4_K_M） | 33+ 种 | `ollama pull kaelri/hy-mt2:1.8b-q4_K_M`（社区打包），或从 Hugging Face 下载官方 GGUF 自行导入 | HY-MT 专用 | ✅ 本项目实测，默认推荐 |
| Hy-MT2-7B（腾讯混元） | ~4–5GB（Q4） | 33+ 种 | Hugging Face 官方仓库 / GGUF | HY-MT 专用 | 质量更高、速度更慢，未实测 |
| TranslateGemma 4B / 12B（Google，2026-01） | 3.3GB / 8.1GB | 55 种 | `ollama pull translategemma:4b` | 通用 | Ollama 官方库提供；官方有专用提示格式，本扩展尚未内置，未实测 |
| Seed-X-PPO-7B（字节跳动） | ~4.3GB（Q4） | 28 种 | 社区 GGUF | 通用 | 官方推荐 vLLM + beam search，不推荐非官方量化版，未实测 |
| 通用小模型（Qwen3、Gemma 3 等） | — | 多 | `ollama pull ...` | 通用 | 也能用；带思考模式的模型会明显变慢 |

- 「HY-MT 专用」提示词按官方模型卡：译成中文用中文指令，译成其他语言用英文指令。
- 许可证以各模型的官方模型卡为准（Hy-MT2 的 Ollama 打包附带 Tencent HY Community License）。
- 想追求速度：1–2B 级专用翻译模型在字幕场景足够；7B 以上更适合网页长段落。

## 连接助手（可选）

`scripts/relay.mjs` 是一个只监听 `127.0.0.1:11435` 的小代理，只放行本扩展的请求。以下情况用它：

- 不想改 Ollama 的 `OLLAMA_ORIGINS`；
- 模型跑在另一台机器上（经 SSH 隧道转发，对方端口不用对外开放）；
- 要用没有 CC 视频的语音转写（转发 `/asr`）。

```bash
npm run relay -- --extension-id <扩展ID>                 # 模型在本机
npm run relay -- --extension-id <扩展ID> --ssh my-server # 模型在另一台机器（ssh 能直接登录的主机名）
```

扩展 ID 在弹窗「模型连接」底部的命令里可以直接复制。启动后把 Base URL 改成 `http://127.0.0.1:11435`。

## 没有 CC 的视频：语音转写（可选，Apple Silicon）

绝大多数 YouTube 英文视频都有自动字幕，这项功能只在少数没有字幕的视频上用到。

- `server/asr.py`：`GET /asr?v=<视频ID>&start=<秒>`。用 yt-dlp 下载音频，mlx-whisper（small）从当前位置开始每 2 分钟一片转写，结果缓存在 `cache/`。M1 上首句约 30 秒，69 分钟视频约 3.5 分钟转完。
- 依赖：`yt-dlp`、`ffmpeg`（Homebrew），Python 3.13。
- 部署为 LaunchAgent（只监听 `127.0.0.1:11440`）：

```bash
npm run deploy:asr -- <ssh 主机>   # 也可以是本机：先在 ~/.ssh/config 配好 localhost
```

- 扩展通过连接助手访问它：开启双语字幕 6 秒后仍没有任何字幕时，自动请求转写。
- 已知限制：每 2 分钟一片，片段交界处句子可能被切开；拖动进度条不会调整转写顺序；多个视频排队转写。

## 目录

```
src/            扩展源码（esbuild 打包到 dist/，并复制到根目录方便直接加载）
  background.js 消息边界、主机授权、翻译与转写请求
  offscreen.js  代发请求：Chrome 138+ 会拦截 service worker 访问本机地址，扩展页面不受影响
  content.js    字幕层、时间轴预译 / 实时字幕、转写兜底、网页翻译入口
  bridge.js     页面主环境，只读取 YouTube 自己请求的字幕响应
  page.js       网页对照翻译
  translator.js 模型请求、缓存、超时
  core.js       设置校验、提示词、字幕解析
scripts/        build / package / relay（连接助手）/ preview / verify-*
server/         语音转写服务 asr.py、LaunchAgent 模板与部署脚本
test/           node --test 单元测试
```

## 开发与验证

```bash
npm test                                    # 单元测试
npm run dev                                 # 弹窗界面预览 http://127.0.0.1:4318
npm run verify:model                        # 真实模型：Ollama / OpenAI 兼容两种协议
npm run verify:flow                         # 合成播放器 + 真实模型：实时字幕、时间轴预译、网页翻译与恢复
RELAY_URL=http://127.0.0.1:11435 npm run verify:asr   # 合成播放器（无 CC）+ 真实转写与翻译
npm run package                             # 打包 release/yiban-lite-<版本>.zip
```

`verify:*` 默认连 `http://127.0.0.1:11434` 的默认模型，可用 `BASE_URL`、`MODEL` 环境变量覆盖。

## 隐私与权限

- 默认只申请 YouTube 页面权限；模型地址的访问权限在你保存设置时按主机单独申请。
- 模型地址只允许本机或局域网（localhost、127.x、10.x、172.16–31.x、192.168.x、*.local）。
- 字幕截获只读取 YouTube 播放器自己发出的字幕请求响应，不读 Cookie、不构造签名请求。

## License

MIT
