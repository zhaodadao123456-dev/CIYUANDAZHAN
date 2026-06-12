#!/usr/bin/env bash
# ============================================================
# 次元大战 3D · 腾讯云一键部署脚本（Ubuntu / TencentOS / CentOS）
# 用法：以 root 在服务器上执行
#   curl -fsSL https://raw.githubusercontent.com/zhaodadao123456-dev/CIYUANDAZHAN/main/dimensional-war-3d/deploy/quickstart.sh | bash
# 或下载后： bash quickstart.sh
# 完成后浏览器访问 http://<服务器公网IP> 即可游玩
# （记得在腾讯云控制台防火墙/安全组放行 80 端口）
# ============================================================
set -e

OWNER_REPO="zhaodadao123456-dev/CIYUANDAZHAN"
BRANCH="main"
DIR=/opt/dimensional-war-3d
PORT=80

echo "==> 1/4 安装 Node.js 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    echo "未找到 apt/yum/dnf，请手动安装 Node.js 18+ 后重试"; exit 1
  fi
fi
echo "    Node.js 版本：$(node -v)"

echo "==> 2/4 拉取游戏代码（多镜像轮试，无需直连 github.com）"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="https://github.com/$OWNER_REPO/archive/refs/heads/$BRANCH.tar.gz"
URLS=(
  "https://codeload.github.com/$OWNER_REPO/tar.gz/refs/heads/$BRANCH"
  "$ARCHIVE"
  "https://mirror.ghproxy.com/$ARCHIVE"
  "https://ghproxy.net/$ARCHIVE"
  "https://gh-proxy.com/$ARCHIVE"
)
GOT=""
for u in "${URLS[@]}"; do
  echo "    尝试 $u"
  if curl -fSL --connect-timeout 10 --max-time 300 "$u" -o "$TMP/src.tar.gz" 2>/dev/null \
     && tar -tzf "$TMP/src.tar.gz" >/dev/null 2>&1; then
    GOT=1; echo "    ✅ 下载成功"; break
  fi
done
[ -n "$GOT" ] || { echo "❌ 所有下载源均失败，请稍后重试"; exit 1; }
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 2 -type d -name dimensional-war-3d | head -1)
[ -n "$SRC" ] || { echo "❌ 压缩包中未找到 dimensional-war-3d 目录"; exit 1; }

mkdir -p "$DIR"
# 保留玩家存档，其余文件全部更新
[ -f "$DIR/players.json" ] && cp "$DIR/players.json" "$TMP/players.json.keep"
cp -a "$SRC/." "$DIR/"
[ -f "$TMP/players.json.keep" ] && cp "$TMP/players.json.keep" "$DIR/players.json"

cd "$DIR"
echo "    安装依赖（npm 官方源失败时自动切换国内源）"
npm install --omit=dev --no-audit --no-fund \
  || npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com

echo "==> 3/4 注册 systemd 服务（开机自启/崩溃自动重启）"
cat > /etc/systemd/system/dimensional-war-3d.service <<EOF
[Unit]
Description=Dimensional War 3D Game Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Environment=PORT=$PORT
# 重叠战场节奏（分钟）：开服热场建议短一些
Environment=WAR_INTERVAL_MINUTES=10
Environment=WAR_DURATION_MINUTES=5
# 管理接口密钥（手动开战用），建议改成随机串
Environment=ADMIN_KEY=$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dimensional-war-3d
systemctl restart dimensional-war-3d

echo "==> 4/4 完成！"
sleep 1
systemctl --no-pager -l status dimensional-war-3d | head -8
IP=$(curl -s --max-time 5 ifconfig.me || echo "<服务器公网IP>")
echo ""
echo "================================================================"
echo "🌌 部署成功！浏览器访问：  http://$IP"
echo "   （需在腾讯云控制台「防火墙/安全组」放行 ${PORT} 端口）"
echo "   把地址发给好友，选不同次元即可实时对战！"
echo "   查看日志：journalctl -u dimensional-war-3d -f"
echo "   手动开战：grep ADMIN_KEY /etc/systemd/system/dimensional-war-3d.service"
echo "================================================================"
