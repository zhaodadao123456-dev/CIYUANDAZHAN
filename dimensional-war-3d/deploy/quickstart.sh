#!/usr/bin/env bash
# ============================================================
# 次元大战 3D · 腾讯云一键部署脚本（Ubuntu 20.04/22.04）
# 用法：以 root 在服务器上执行
#   curl -fsSL https://raw.githubusercontent.com/zhaodadao123456-dev/CIYUANDAZHAN/main/dimensional-war-3d/deploy/quickstart.sh | bash
# 或下载后： bash quickstart.sh
# 完成后浏览器访问 http://<服务器公网IP> 即可游玩
# （记得在腾讯云控制台防火墙/安全组放行 80 端口）
# ============================================================
set -e

REPO="https://github.com/zhaodadao123456-dev/CIYUANDAZHAN.git"
BRANCH="main"
DIR=/opt/dimensional-war-3d
PORT=80

echo "==> 1/4 安装 Node.js 20 与 git"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git >/dev/null 2>&1 || true

echo "==> 2/4 拉取游戏代码"
if [ -d "$DIR/.git-src" ]; then
  git -C "$DIR/.git-src" pull
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR/.git-src"
fi
rsync -a --exclude players.json "$DIR/.git-src/dimensional-war-3d/" "$DIR/"
cd "$DIR"
npm install --omit=dev --no-audit --no-fund

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
