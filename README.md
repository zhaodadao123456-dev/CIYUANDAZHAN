# 🌌 次元大战 · CIYUANDAZHAN

五大次元世界（科技/修仙/赛博朋克/西方魔法/猎人）彼此征伐的多人游戏，三个版本：

| 目录 | 版本 | 说明 |
|------|------|------|
| [`dimensional-war-3d/`](dimensional-war-3d/) | **3D 实时动作多人版（主打）** | Three.js 实时战斗 + KayKit 专业美术 + 骨骼动画 + 粒子特效 + 音乐音效 + 手机虚拟摇杆；Node.js 权威服务器，重叠战场实时 PvP |
| [`dimensional-war-online/`](dimensional-war-online/) | 2D 多人在线版 | 账号系统、每周次元大战、重叠区掠夺真实玩家、邀请码世界意志奖励、次元聊天 |
| [`dimensional-war/`](dimensional-war/) | 单机网页版 | 零依赖，浏览器打开 `standalone.html` 即玩 |

## 🚀 一键部署（腾讯云 Ubuntu）

```bash
curl -fsSL https://raw.githubusercontent.com/zhaodadao123456-dev/CIYUANDAZHAN/main/dimensional-war-3d/deploy/quickstart.sh | bash
```

放行 80 端口后访问 `http://服务器公网IP` 即可游玩。详细文档见各目录 README。

## 素材授权

全部第三方素材均为 CC0（可免费商用、无需署名）：
- 模型：KayKit（Adventurers / Skeletons / Dungeon Remastered / Space Base / City Builder / Halloween / Medieval Hexagon）
- 音频：Juhani Junkala（Chiptune Adventures / 512 Sound Effects，OpenGameArt）

授权文件随包附在 `dimensional-war-3d/public/assets/`。
