"""译伴 ASR：给没有 CC 的 YouTube 视频生成带时间轴的字幕（Apple Silicon + mlx-whisper，仅监听本机）。

GET /asr?v=<videoId>&start=<秒>  → {status, language, duration, done, total, cues: [{start, end, text}]}
首次请求启动任务，之后轮询拿增量结果；从 start 所在片段开始转写，再补其余片段。
"""
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import mlx_whisper

BIN = os.environ.get('YIBAN_BIN', '/opt/homebrew/bin')
# mlx_whisper 内部按 PATH 调 ffmpeg，LaunchAgent 的 PATH 里没有 Homebrew
os.environ['PATH'] = f"{BIN}:{os.environ.get('PATH', '')}"
MODEL = os.environ.get('YIBAN_ASR_MODEL', 'mlx-community/whisper-small-mlx')
PORT = int(os.environ.get('YIBAN_ASR_PORT', '11440'))
CACHE = Path(os.environ.get('YIBAN_ASR_CACHE', Path(__file__).with_name('cache')))
CHUNK = 120  # 秒；越短第一句越快，代价是片段边界处句子可能被切开
MAX_DURATION = 4 * 3600
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')

# ponytail: 全局锁串行转写，一块 GPU 并行也不会更快；多用户时再做队列
gpu = threading.Lock()
jobs = {}
jobs_lock = threading.Lock()


def run(*args, timeout=60):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True).stdout.strip()


class Job:
    def __init__(self, video_id, start):
        self.video_id, self.start = video_id, start
        self.status, self.error, self.language, self.duration = 'starting', '', None, 0
        self.cues, self.done, self.total, self.failed_at = [], 0, 0, 0
        threading.Thread(target=self.work, daemon=True).start()

    def view(self):
        return {'status': self.status, 'error': self.error, 'language': self.language, 'duration': self.duration,
                'done': self.done, 'total': self.total, 'cues': sorted(self.cues, key=lambda c: c['start'])}

    def work(self):
        try:
            self.status = 'downloading'
            with tempfile.TemporaryDirectory() as tmp:
                # ffmpeg 直接读 googlevideo 直链会被限速卡死，先用 yt-dlp（分段请求）下完整音频，69 分钟约 30 秒
                # --ignore-config：不受本机 yt-dlp 全局配置（写字幕、读浏览器 Cookie）影响
                self.duration = float(run(f'{BIN}/yt-dlp', '--ignore-config', '--no-playlist', '-q', '-f', 'bestaudio[ext=m4a]/bestaudio',
                                          '--match-filter', f'duration<={MAX_DURATION}', '--no-simulate', '--print', 'duration',
                                          '-o', f'{tmp}/audio', f'https://www.youtube.com/watch?v={self.video_id}', timeout=900) or 0)
                if not self.duration or not os.path.exists(f'{tmp}/audio'):
                    raise RuntimeError('音频下载失败，或视频超过 4 小时')
                count = int(-(-self.duration // CHUNK))
                first = min(int(self.start // CHUNK), count - 1)
                order = list(range(first, count)) + list(range(0, first))
                self.total, self.status = count, 'transcribing'
                for index in order:
                    offset = index * CHUNK
                    wav = f'{tmp}/{index}.wav'
                    run(f'{BIN}/ffmpeg', '-v', 'error', '-y', '-ss', str(offset), '-t', str(CHUNK), '-i', f'{tmp}/audio',
                        '-vn', '-ac', '1', '-ar', '16000', wav)
                    with gpu:
                        result = mlx_whisper.transcribe(wav, path_or_hf_repo=MODEL, language=self.language,
                                                        condition_on_previous_text=False)
                    os.remove(wav)
                    self.language = self.language or result.get('language')
                    for s in result['segments']:
                        text = s['text'].strip()
                        if text and s['end'] > s['start']:
                            self.cues.append({'start': round(offset + s['start'], 2), 'end': round(offset + s['end'], 2), 'text': text[:2000]})
                    self.done += 1
            self.status = 'done'
            CACHE.mkdir(parents=True, exist_ok=True)
            (CACHE / f'{self.video_id}.json').write_text(json.dumps(self.view(), ensure_ascii=False))
        except Exception as error:  # 任务线程里的失败都要返回给插件，否则只会一直“识别中”
            traceback.print_exc()
            self.status, self.error, self.failed_at = 'error', (getattr(error, 'stderr', '') or repr(error))[-300:], time.time()


def get_job(video_id, start):
    cached = CACHE / f'{video_id}.json'
    if cached.exists():
        return json.loads(cached.read_text())
    with jobs_lock:
        job = jobs.get(video_id)
        # 失败后保留 60 秒让插件看到错误，之后的请求才重试
        if not job or (job.status == 'error' and time.time() - job.failed_at > 60):
            if len(jobs) >= 20:  # 只留最近的任务，避免常驻内存无限增长
                jobs.pop(next(iter(jobs)))
            job = jobs[video_id] = Job(video_id, start)
    return job.view()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        video_id = (query.get('v') or [''])[0]
        if url.path == '/health':
            return self.reply(200, {'ok': True, 'model': MODEL, 'jobs': len(jobs)})
        if url.path != '/asr' or not VIDEO_ID.match(video_id):
            return self.reply(404, {'error': '未知请求'})
        try:
            start = max(0.0, float((query.get('start') or ['0'])[0]))
        except ValueError:
            start = 0.0
        self.reply(200, get_job(video_id, start))

    def reply(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print(f'译伴 ASR 已启动：http://127.0.0.1:{PORT}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
