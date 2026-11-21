#!/bin/bash
# 在服务器上无人值守录制「在线看板」演示视频 v2
#   就绪前不录：Xvfb → 浏览器加载看板 → 写 rec-ready → 起 ffmpeg → rec-go → 页签浏览 → rec-done → 停止录制
set -u

OUT=/root/recorder/judge-demo.mp4
export DISPLAY=:99
READY=/tmp/rec-ready
GO=/tmp/rec-go
DONE=/tmp/rec-done

echo "=== 0) 清理 ==="
pkill -f "Xvfb :99" 2>/dev/null || true
pkill -f "google-chrome" 2>/dev/null || true
rm -f "$READY" "$GO" "$DONE"
sleep 1

echo "=== 1) 虚拟显示 ==="
Xvfb :99 -screen 0 1600x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2

echo "=== 2) 只读账号（来自 .relay.env） ==="
. /root/api-relay/.relay.env
export RV_USER="$RELAY_VIEWER_USER"
export RV_PASS="$RELAY_VIEWER_PASSWORD"
export RV_CHROME=/usr/bin/google-chrome
export RV_BASE=http://127.0.0.1:8787

echo "=== 3) 启动浏览器并加载看板（后台） ==="
cd /root/recorder
node record.js > /tmp/record.log 2>&1 &
REC_PID=$!

echo "=== 4) 等待页面就绪 ==="
for i in $(seq 1 120); do
  [ -f "$READY" ] && break
  sleep 1
done
if [ ! -f "$READY" ]; then
  echo "页面未就绪，日志："; tail -10 /tmp/record.log; kill $XVFB_PID 2>/dev/null; exit 1
fi
echo "就绪，开始录屏"

echo "=== 5) ffmpeg 录屏（就绪后开始，杜绝片头白屏） ==="
rm -f "$OUT"
ffmpeg -y -loglevel error \
  -f x11grab -framerate 15 -video_size 1600x900 -i :99.0 \
  -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -movflags +faststart \
  "$OUT" >/tmp/ffmpeg.log 2>&1 &
FF_PID=$!
sleep 1
touch "$GO"

echo "=== 6) 等待演示结束 ==="
for i in $(seq 1 240); do
  [ -f "$DONE" ] && break
  sleep 1
done
sleep 1
kill -INT "$FF_PID" 2>/dev/null || true
wait "$FF_PID" 2>/dev/null || true
kill "$XVFB_PID" 2>/dev/null || true

echo "=== 7) 产物 ==="
tail -3 /tmp/record.log
ls -lh "$OUT" 2>/dev/null || { echo "未生成视频"; tail -5 /tmp/ffmpeg.log; exit 1; }
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 "$OUT"