#!/bin/sh
# 把语音转写服务部署到一台 Apple Silicon Mac（本机或 SSH 主机），以 LaunchAgent 常驻，只监听 127.0.0.1:11440
# 用法：sh server/deploy.sh <ssh 主机>      例：sh server/deploy.sh my-mac-mini
# 环境变量：ASR_DIR 远端目录（默认 ~/AI/yiban-asr），PYTHON 建 venv 用的解释器（默认 python3.13）
set -e
host="$1"; [ -n "$host" ] || { echo '用法：sh server/deploy.sh <ssh 主机>'; exit 1; }
dir="${ASR_DIR:-AI/yiban-asr}"; py="${PYTHON:-python3.13}"
cd "$(dirname "$0")"
ssh "$host" "mkdir -p ~/$dir"
scp -q asr.py "$host:$dir/asr.py"
# 首次部署建独立 venv（mlx-whisper 依赖 numba，Python 版本别用太新的）
ssh "$host" "cd ~/$dir && (test -x .venv/bin/python || (PATH=/opt/homebrew/bin:\$PATH $py -m venv .venv && .venv/bin/pip install -q mlx-whisper==0.4.3))"
ssh "$host" "sed \"s#__DIR__#\$HOME/$dir#g\" > ~/Library/LaunchAgents/yiban.asr.plist" < yiban-asr.plist
# 已加载就 kickstart -k 重启（bootout 是异步的，紧跟 bootstrap 会报 I/O error）；plist 改动需先手动 bootout
ssh "$host" 'launchctl kickstart -k gui/$(id -u)/yiban.asr 2>/dev/null || launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/yiban.asr.plist'
sleep 3
ssh "$host" 'curl -s -m 3 http://127.0.0.1:11440/health'
