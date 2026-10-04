#!/usr/bin/env bash
# 安装上游 runtime（dsh-blender-plugin）到 vendor/ —— macOS / Linux
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$HERE/vendor/dsh-blender-plugin"
if [ -f "$VENDOR/runtime/server.mjs" ]; then
  echo "runtime 已存在：$VENDOR/runtime/server.mjs"
  exit 0
fi
mkdir -p "$HERE/vendor"
git clone --depth 1 https://github.com/sixtysevenlf/dsh-blender-plugin.git "$VENDOR"
echo "已装上游 runtime：$VENDOR/runtime/server.mjs"
echo "验收：blender_viewport(op='doctor') 必须返回 kind=ok"
