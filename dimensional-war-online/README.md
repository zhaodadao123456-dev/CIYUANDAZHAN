# 🌌 次元大战 Online · 多人版

真正的多人在线版本：Node.js + WebSocket 服务端权威架构，所有玩家共享同一个持久世界。
单机版见 [`../dimensional-war/`](../dimensional-war/)。

## 与单机版的区别（真·多人）

- **统一世界时钟**：服务器推进游戏日，所有玩家同步。默认 1 游戏日 = 现实 1 天，**次元大战每周一次**（可配置加速）
- **真实账号**：注册/登录（密码 scrypt 加密），断线重连，单点登录
- **真实掠夺**：重叠区遭遇的是**真实玩家**（在线或离线化身，使用其真实属性装备），击杀后真实扣除对方金币、夺走对方背包装备，对方会收到战报邮件；战败者 30 分钟保护、同一对手 1 小时锁定，防止反复刷
- **战意系统**：重叠区每次击杀为本方次元 +1 战意，直接计入大战战力——PvP 表现真实影响大战胜负
- **大战全员结算**：战力 = 所有玩家战力×3 + 次元底蕴 + 战意，败方全体玩家（含离线）重生到其他次元并收到邮件
- **真实邀请码**：好友注册时填你的邀请码即降临你的世界，世界意志立刻给你发奖（金币/史诗·传说装备/永久加成），好友本身就是本方战力
- **次元频道聊天**、**战力排行榜**、**世界动态广播**、**赛季制**（决出冠军后次日自动开启新赛季，进度保留）
- 体力制（50 上限，3 分钟回 1 点）、离线缓慢回血，适合长线多人节奏

## 本地运行

```bash
cd dimensional-war-online
npm install
GAME_DAY_MINUTES=2 ADMIN_KEY=test123 npm start   # 加速模式：14分钟一周
# 浏览器打开 http://localhost:3000 （开多个无痕窗口注册多个账号即可联机测试）
# 手动推进一天：curl "http://localhost:3000/admin/tick?key=test123"
```

## 🚀 腾讯云部署指南

### 1. 购买服务器

- **轻量应用服务器**（推荐，新手友好）或 CVM 均可，最低配置（2核2G）足够
- 镜像选 **Ubuntu 22.04 LTS**
- 在控制台「防火墙/安全组」中放行端口：`80`（HTTP）、`3000`（测试用，可选）

### 2. 安装环境

SSH 登录服务器后：

```bash
# 安装 Node.js 20（国内服务器建议用腾讯云镜像源加速）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 拉取代码
sudo git clone https://github.com/zhaodadao123456-dev/CIYUANDAZHAN.git /opt/repo
sudo cp -r /opt/repo/dimensional-war-online /opt/dimensional-war-online
cd /opt/dimensional-war-online
npm install --omit=dev
# 若 npm 太慢：npm config set registry https://mirrors.cloud.tencent.com/npm/
```

### 3. 试运行

```bash
PORT=3000 node server.js
# 浏览器访问 http://<服务器公网IP>:3000 能打开游戏即成功，Ctrl+C 停止
```

### 4. 注册为系统服务（开机自启、崩溃自动重启）

```bash
sudo cp deploy/dimensional-war.service /etc/systemd/system/
sudo nano /etc/systemd/system/dimensional-war.service   # 按需修改 ADMIN_KEY 等
sudo systemctl daemon-reload
sudo systemctl enable --now dimensional-war
sudo systemctl status dimensional-war    # 查看运行状态
journalctl -u dimensional-war -f         # 查看日志
```

### 5.（推荐）Nginx 反向代理到 80 端口

```bash
sudo apt-get install -y nginx
sudo tee /etc/nginx/sites-available/dimensional-war <<'NGINX'
server {
    listen 80;
    server_name _;   # 有域名则填域名
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # WebSocket 必需
        proxy_set_header Connection "upgrade";      # WebSocket 必需
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/dimensional-war /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

之后直接访问 `http://<公网IP>/` 即可。把这个地址（和你的邀请码）发给好友就能一起玩。

### 6.（可选）域名 + HTTPS

域名解析到服务器 IP 并完成备案后：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

客户端会自动随 https 切换为 wss 加密连接，无需改代码。

### 7. 运维要点

| 事项 | 说明 |
|------|------|
| 存档 | 世界数据保存在 `world.json`（每30秒落盘），备份该文件即可 |
| 调速 | `GAME_DAY_MINUTES` 控制游戏日时长：`1440`=每周真实开战一次；开服前期可设 `60`（一周≈7小时）热场 |
| 测试 | 设置 `ADMIN_KEY` 后用 `curl "http://IP/admin/tick?key=KEY"` 手动推进游戏日，快速演练大战 |
| 监控 | `GET /health` 返回赛季/天数/玩家数/在线数，可接腾讯云监控拨测 |
| 升级 | `cd /opt/repo && sudo git pull && sudo cp -r dimensional-war-online/* /opt/dimensional-war-online/ && sudo systemctl restart dimensional-war`（world.json 不会被覆盖） |

## 架构说明

```
dimensional-war-online/
├── server.js            # 服务端：HTTP静态 + WebSocket + 世界时钟 + 战斗/大战/掠夺/邀请结算
├── game/data.js         # 五大次元共享数据（服务端/客户端通用 UMD 模块）
├── public/
│   ├── index.html       # 登录注册 + 游戏主界面
│   ├── client.js        # WebSocket 客户端、渲染、断线重连
│   └── style.css
├── deploy/dimensional-war.service   # systemd 服务文件
└── world.json           # 运行时生成的世界存档（已 gitignore）
```

**服务端权威**：战斗回合、掉落、掠夺、大战结算全部在服务器计算，客户端只发送操作意图，无法作弊改数值。

**协议**（JSON over WebSocket `/ws`）：
- C→S：`register / login / resume / hunt / act / flee / equip / sell / chat / world / you / top`
- S→C：`auth / you / world / combat / combatEnd / event / log / chat / mail / top / error`
