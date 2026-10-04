# 安装上游 runtime（dsh-blender-plugin）到 vendor/ —— Windows / PowerShell
# 用法：powershell -ExecutionPolicy Bypass -File scripts/install-runtime.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $here "vendor\dsh-blender-plugin"
if (Test-Path (Join-Path $vendor "runtime\server.mjs")) {
  Write-Host "runtime 已存在：$vendor\runtime\server.mjs"
  exit 0
}
New-Item -ItemType Directory -Force -Path (Join-Path $here "vendor") | Out-Null
git clone --depth 1 https://github.com/sixtysevenlf/dsh-blender-plugin.git $vendor
Write-Host "已装上游 runtime：$vendor\runtime\server.mjs"
Write-Host "验收：blender_viewport(op='doctor') 必须返回 kind=ok"
