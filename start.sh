#!/bin/bash
# 启动本地服务器,然后自动打开浏览器
# 用法: bash start.sh
cd "$(dirname "$0")"
PORT="${1:-8765}"
if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x /opt/homebrew/bin/node ]; then
  NODE=/opt/homebrew/bin/node
else
  echo "未找到 node,请先安装 Node.js"; exit 1
fi
"$NODE" test/server.mjs "$(pwd)" "$PORT" &
SERVER_PID=$!
sleep 1
URL="http://127.0.0.1:$PORT"
if curl -s -o /dev/null --max-time 3 "$URL/index.html"; then
  echo "服务器已启动: $URL"
  open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true
else
  echo "启动失败,请检查端口 $PORT 是否被占用"
  kill $SERVER_PID 2>/dev/null
fi
