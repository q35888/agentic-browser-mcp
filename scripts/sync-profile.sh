#!/usr/bin/env bash
# sync-profile.sh — 把日常 Chrome profile 的登录态同步到 agentic-browser 专用 profile。
#
# 背景:Chrome 136+ 安全限制禁止默认 profile 开 --remote-debugging-port,
# 所以 agentic-browser 用独立 profile;但用户希望专用 Chrome 复用日常登录态。
# 本脚本拷贝 Cookies / Login Data / Web Data 到专用 profile,GNOME keyring 同用户共享,
# 加密 cookie 可直接解密。
#
# 用法:
#   1. 日常 Chrome 关闭(或至少保证没在写 Cookies);本脚本会尝试自动 SIGSTOP/继续
#   2. agentic-browser 的专用 Chrome 关闭(脚本会先 kill 9222 端口的 chrome)
#   3. 运行:~/.pi/agent/sync-profile.sh

set -euo pipefail

SRC_PROFILE="${HOME}/.config/google-chrome"
DST_PROFILE="${AGENT_BROWSER_CDP_PROFILE:-$HOME/.pi/agent/chrome-cdp-profile}"
CHROME_BIN="${CHROME_BIN:-google-chrome-stable}"

log() { echo "[sync-profile] $*"; }
die() { echo "[sync-profile] 错误: $*" >&2; exit 1; }

# 1. 参数检查
[ -d "$SRC_PROFILE/Default" ] || die "日常 profile 不存在: $SRC_PROFILE/Default"
[ -d "$DST_PROFILE/Default" ] || die "目标 profile 不存在: $DST_PROFILE/Default(还没用过 agentic-browser?)"

# 2. 关掉专用 Chrome(占 9222 的)
PORT_PID=$(ss -tlnp 2>/dev/null | grep ':9222' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1 || true)
if [ -n "$PORT_PID" ]; then
  log "关闭专用 Chrome(PID $PORT_PID)"
  kill "$PORT_PID" 2>/dev/null || true
  sleep 2
fi

# 3. 日常 Chrome 若在跑,提示用户 cookie 可能不完整
if pgrep -u "$(id -u)" -f "${CHROME_BIN##*/}" >/dev/null 2>&1; then
  log "⚠️  日常 Chrome 还在跑。为保证拷到最新 cookie,建议先关掉。"
  log "   继续 3 秒后拷贝(按 Ctrl-C 取消)..."
  sleep 3
fi

# 4. 备份目标 profile 的认证文件
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${DST_PROFILE}/.sync-backup/${TS}"
mkdir -p "$BACKUP_DIR"
log "备份目标 profile 到 $BACKUP_DIR"

# 5. 拷贝认证相关文件
FILES=(
  "Default/Cookies"
  "Default/Login Data"
  "Default/Login Data For Account"
  "Default/Web Data"
  "Local State"
)
copied=0
for f in "${FILES[@]}"; do
  src="$SRC_PROFILE/$f"
  dst="$DST_PROFILE/$f"
  [ -f "$src" ] || { log "  - 跳过 $f(源不存在)"; continue; }
  [ -f "$dst" ] && cp "$dst" "$BACKUP_DIR/$(basename "$f")" 2>/dev/null || true
  mkdir -p "$(dirname "$dst")"
  if cp "$src" "$dst" 2>/dev/null; then
    log "  ✓ $f"
    copied=$((copied+1))
  else
    log "  ✗ $f(文件被占用?)"
  fi
done

# 6. 清理可能残留的锁文件
rm -f "$DST_PROFILE"/Singleton* "$DST_PROFILE"/DevToolsActivePort 2>/dev/null || true

log ""
log "完成:拷贝 $copied 个文件"
log "下次 agentic-browser 拉起 Chrome 时,登录态即与日常 profile 同步。"
log "备份保留在: $BACKUP_DIR(出问题可回滚)"
