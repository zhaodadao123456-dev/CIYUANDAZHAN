# CLAUDE.md — 次元大战（Dimensional War）项目上下文

> 本文件在**每个新会话开始时自动读取**，是项目的完整交接文档。换会话继续开发，只要已提交到仓库，上下文就不丢。
> **改动较大时请顺手更新「当前状态/路线图」。**

## 一句话简介
多人在线动作 RPG：**5 个次元 × 5 个职业**、实时战斗、世界BOSS、PvP 重叠战场、每晚五次元大混战。
一套权威服务器 + 两个客户端：**网页版（Three.js，最完善，已冻结不再开发）** 和 **Unity 原生客户端（出 iOS/安卓/PC，当前开发重点）**。两端连同一服务器、**共用按昵称的玩家存档**。

## 仓库结构（重点只看前两个）
- `dimensional-war-3d/` — **主项目**：Node.js 权威服务器(`server.js`) + 网页版前端(`public/`)。
- `unity-client/` — Unity 原生客户端（**当前主要在改这个**）。
- `dimensional-war-online/`、`dimensional-war/` — 早期 2D/单机版，基本不动。

## 开发 / 测试 / 部署
- **冒烟测试（每次改服务器 `server.js` 必跑，必须全绿）**：
  ```bash
  cd dimensional-war-3d && rm -f players.json && node smoke-test.js   # 目前 34/34
  ```
  加速环境变量：`DW_BOSS_MS`(BOSS刷新) `DW_BOSS_HP` `DW_LAIR_R`(巢穴距离) `DW_MELEE_NOW=1` `DW_MELEE_MS`。
- **语法检查**：`node --check server.js`。改完 Unity `.cs` 用大括号配平自检：`{ 数 == } 数`（这边没有 C# 编译器，靠配平+人审）。
- **服务器部署**（用户在腾讯云跑，端口 80；公网IP **119.45.129.74**）：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/zhaodadao123456-dev/CIYUANDAZHAN/main/dimensional-war-3d/deploy/quickstart.sh | bash
  ```
- **Unity 出 iOS 包**（在用户 Mac + Unity，需装 iOS Build Support 模块）：菜单 **「次元大战 → ④ 准备iOS」「⑤ 导出iOS工程(Xcode)」**（`Editor/DWBuildIOS.cs`）自动建空场景+加入 Build Settings+设包名/横屏/IL2CPP/自动签名+导出 Xcode 到工程根 `iOSBuild/`；再用 Xcode 选开发者团队签名→连手机▶运行。免费证书 7 天过期，重导即可。`Editor/DWiOSPostBuild.cs` 自动放行明文 ws://（否则真机连不上）。
- **Unity 客户端更新**：用户重下仓库 ZIP（`main`），覆盖 `unity-client/Assets/Scripts/`（含 `Editor/`）+ `Assets/Resources/DWIcons/` + 改了包依赖时的 `Packages/manifest.json`；**不要覆盖整个 Assets**（会删掉用户买的、不在仓库里的角色/特效包）。
- **网页版玩**：浏览器/iPhone Safari 开 `http://119.45.129.74`。

## 约定（重要）
- 提交信息结尾带：`https://claude.ai/code/session_01NaWopDCG3d65MiQHLnzuum`（沿用即可）。
- **提交并推 `main`**（用户从 main 下载/部署）。先提交/推送，未提交的会随容器回收丢失。
- **不要**把模型标识、`[1m]` 等写进任何提交/代码/文档。
- C# 在 `using System;` 下别用裸 `Object.Destroy`（与 System.Object 冲突）→ 用 `Destroy(...)`。
- **Unity UGUI/IMGUI 文本不要用 emoji**：动态 CJK 系统字体不含 emoji 字形，会显示成空方块/消失（🎒🚪💰🌀）。用中文文字或程序化图标。服务器下发的 feed/toast 若含 emoji，在 Unity 端也会缺字（网页端正常）——已知遗留。
- **Unity 改动是「盲改」**：这边无法运行/预览 Unity，UI 坐标/观感类改动必须靠用户截图反馈来校准；做大改前优先用「程序化兜底 + 素材可选」的稳健写法。

## 服务器架构（`dimensional-war-3d/server.js`，权威）
- WebSocket `/ws`，客户端发 `{t:...}`；服务器 ~20Hz tick、~10Hz 快照(`snap`)。
- 房间：5 个次元各一张图 + `war`(重叠战场) + `melee`(大混战)。
- 数据在 `public/js/data.js`（DIMENSIONS/CLASSES/RARITIES/MAP_HALF=210/LAIR_R=174），**服务器与网页前端共用**；Unity 端另有 `DWData.cs`（数值需手动同步）。
- 职业：warrior/assassin/ranger/tank/healer；技能 kind：melee/proj/aoe/dashmelee/heal/aoeheal。
- 已实现：5职业(basic/q/e/r，**无上限**升级)、**次元专属技能**(F键：科技护盾/修仙回血/赛博闪现/魔法禁锢/猎人捕宠)、装备(掉落/商店/强化+1~20/融合/词缀/可装备成就)、药剂(H喝/自动复活)、**世界BOSS**(多阶段+预警圈`warn`落地判定+5技能；**body radius r=3：模型放大3倍，玩家撞不进、可从边缘打中**)、怪物(等级1~100、精英远程/范围技、按次元染色)、**重叠战场**双次元PvP、**每晚21点五次元大混战**、组队共享经验、成就、PvP段位天梯、**障碍物碰撞**(圆形`obstacles`，玩家+怪物都挡)、每日签到。
- **存档（按昵称，存服务器 `players.json`）**：等级/经验/金币/装备/技能点/成就/宝宝等。**返回玩家用昵称读回同一角色**——`newPlayer` 对已有昵称用存档里的 `dim/cls`（服务器为准），换设备/重装也能找回；新昵称才用本次选择。
- 战场/混战中**死亡不能原地复活**，回本次元复活。
- 关键消息：`welcome/you/snap/cast/proj/dmg/heal/mdie/pdie/lvl/feed/chat/ach/party/pinvite/boss/baoe/maoe/bstorm/warn/dimfx/rooted/war/melee/rank/...`

## 网页客户端（`dimensional-war-3d/public/`）— 已冻结
- `index.html` + `js/game.js` + `js/models.js`(Three.js+KayKit GLB) + `js/data.js` + `js/audio.js` + `style.css`(玻璃拟态)。功能/UI 完善，**用户已明确不再开发网页版**。

## Unity 客户端（`unity-client/`）— 当前开发重点
- Unity **2022.3 LTS**（标准 Unity，**内置渲染管线 Built-in**，非 URP/HDRP）。`Packages/manifest.json` 含内置模块 + `com.unity.cloud.gltfast`(.glb) + `com.unity.ugui` + `com.unity.nuget.newtonsoft-json`。
- 自启动：`DWGame` 用 `[RuntimeInitializeOnLoadMethod]` 引导，无需配置场景。
- **登录**：服务器IP 写死在 `DWGame.DEFAULT_SERVER`(="119.45.129.74")，玩家不填 IP；登录界面只填**昵称+选次元+选职业**。**首次降临后存档，再次启动自动登录跳过填写**（连不上才回登录界面；游戏内「退出」回登录界面可改昵称=换/新建角色）。
- 脚本（都在 `Assets/Scripts/`，`partial class Game`）：
  - `DWGame.cs` — 主逻辑/网络/移动/相机/实体/模型加载(`MakeHero` 按 `hero_{dim}_{cls}`→`hero_{dim}`→池→占位；`MakeCreature` 怪物/BOSS，BOSS×3；`BuildWorld` 程序化网格地面+渐变天空盒+散布道具)/碰撞/**全部战斗特效**(见下)。
  - `DWUguiHud.cs` — **UGUI HUD**（Canvas 1920×1080）：状态栏/血条经验条、技能栏(6格)、大攻击键、横幅、信息流、升级/提示/死亡、背包/商店/属性面板、队伍小血条、**小地图**(左下 RawImage 每帧重绘 ~12.5Hz)、**头顶名牌血条**(独立世界画布逐帧投影)、**伤害飘字**、**登录界面**。图标优先用 `DWIcons` 真图标(白图运行时着色)缺失回退程序化 SDF 字形。**面板/按钮已圆角化**(`RoundSprite` 9-slice)。
  - `DWHud.cs` — 旧 IMGUI，**现仅剩虚拟摇杆 + 聊天输入**；其余为死代码未删。
  - `DWData.cs` `DWNet.cs` `DWAudio.cs`(CC0，M静音) + `DWAnimDriver`(动画)。
  - `Editor/DWSetupWizard.cs` — 菜单「① 生成资源清单 / ② 一键接入已购模型 / ③ 接入Hovl特效」。详见下「向导」。
  - `Editor/DWiOSPostBuild.cs`(ATS放行) `Editor/DWBuildIOS.cs`(④/⑤ 一键出 iOS)。
- `Assets/Resources/`：`DWMon`(KayKit怪物glb) `DWProps`(KayKit场景glb) `DWAudio` `DWIcons`(game-icons.net CC BY 白图)；**向导生成**：`DW/`(hero_{dim}_{cls} 25个 + hero_{dim} + mon_boss) `DWHeroes` `DWMobs` `DWScene` `DWFx`(Hovl特效，运行时按名/池加载，缺失/变粉则程序化兜底)。

### 向导（DWSetupWizard）做什么
- **角色**：小丑(LittleWitch1)→世界BOSS(Generic骨骼用自带动作)；骷髅→怪物池；其余人物→**按「次元×职业」分配 25 个 `hero_{dim}_{cls}`**，用上所有角色。偏好表(可加)：修仙·战士=悟空、修仙·奶妈=兔女郎、修仙·刺客=女巫、魔法·奶妈=修女、魔法·战士=半血、猎人·弓手=牛仔、科技/赛博·战士=士兵妹v1/v2；其余从角色库轮流补满。排除 URP/HDRP 变体(内置管线变粉)、残缺件、特效/粒子预制体(`IsEffectPrefab`，防 FX_Waterfall 混进英雄)。
- **场景道具**(DWScene)：关键词白名单(自然/通用/工业)，**排除武器/地形大块/主题杂物/建筑墙路**；上限 80。`BuildWorld` 在障碍点 + 额外 110 个随机散布，铺满地图；`FixPinkMaterials` 把变粉(不兼容shader)的道具材质换成 Standard。
- **③ Hovl 特效**(opt-in，因内置管线常变粉)：复制命名特效 + **特效池**(`fxp_slash` 整包剑斩 / `fxp_aoe` / `fxp_cast` / `fxp_buff`) + **次元元素池**(`fxp_cast_{dim}`、`fxp_aoe_{dim}`)到 `Resources/DWFx`。

### 战斗特效系统（DWGame，关键设计）
- **取用优先级**：`SpawnPoolFx(cat,dim,seed)` 先取次元元素池 `fxp_{cat}_{dim}` → 通用池 `fxp_{cat}` → `SpawnFx` 命名 Hovl → **程序化兜底**。`FxBroken` 检测 shader 不可用(变粉)就跳过。
- **按技能类型 + 次元元素匹配**：近战/突进→剑斩(整包散列)；远程→该次元元素施法闪光；范围→该次元元素范围魔法(科技闪电/赛博飞刀/修仙自然/魔法能量/猎人陨石)；治疗→魔法阵。`seed=hash(dim+cls+key)` 让**每个次元每个英雄每个技能特效尽量不同**。
- **程序化特效**(永远能渲染、不依赖素材、绝不变粉)：地面扩散光环 `SpawnShockwave`、月牙剑斩 `SpawnSlash`、火花 `SpawnSparks`(ParticleSystem)、光闪 `SpawnFlash`、弹道拖尾、按次元配色(科技蓝/修仙绿/赛博粉/魔法紫/猎人橙)。**删 `Resources/DWFx` 即全程序化。**

### 用户已买资源包（不在仓库，在用户本地 Assets/）
悟空、半血男女/教会侍从、女巫、牛仔女警长、修女、兔女郎、小丑(LittleWitch1)、骷髅合集、科幻士兵、黑暗地牢、**Pure Poly/PurePoly 终极低多边形自然包**、**SimpleNaturePack**、**RPG_FPS 工业道具**、**Hovl Studio 特效**(AAA Projectiles / AOE Magic spells / Magic circles / 3D Lasers / **Sword slash VFX** / RPG VFX Bundle)、PlasmaWeaponVol1(武器,未接)、MapMagic(地形工具,**不用**)、各种武器包。

## 当前状态 / 路线图（改动后请更新）
- ✅ 服务器全部玩法系统完成；冒烟 34/34。服务器IP 写死、按昵称服务器存档、返回玩家找回角色。
- ✅ Unity：连服务器、登录/自动登录、模型按次元×职业接入(含兔女郎=修仙奶妈)、碰撞、横屏、音效、iOS 一键导出。
- ✅ UI 全 UGUI（队伍血条/小地图/头顶名牌/伤害飘字/登录）、真图标、**面板按钮圆角化**。
- ✅ 美术：Pure Poly+工业+自然包铺满地图(已清理武器/地形/杂物)、世界BOSS×3、按技能+次元匹配的特效系统(Hovl池+程序化兜底)。
- ⏳ **待办（多需用户截图校准）**：①**UI 美化下一轮**(配色/玻璃拟态/排版/描边投影/CD反馈，圆角已做)；②UGUI 坐标/大小/锚点真机微调；③**Hovl 在用户内置管线下变粉**——`FxBroken` 会自动跳过、回退程序化(不粉、够看)，若想用 Hovl 需修 shader 或确认包是否 Built-in；④PlasmaWeapon 武器未绑到角色手上。
- ❌ 暂不做：MapMagic 3D 地形（与「服务器 2D 平面、脚踩 y=0」冲突）。

## 给新会话：如何高效继续优化
1. **先读本文件全文**，再动手。Unity 改完务必大括号配平自检；改 server.js 必跑冒烟测试。
2. **看不到 Unity 画面**——UI/观感类改动让用户**截图**(登录界面 / 战斗HUD / 背包面板 / 放技能)再针对性调；优先「程序化兜底 + 素材可选」写法，避免单点失败/变粉。
3. **当前用户最想要的**：把 Unity 整体 UI 做精致(圆角已完成，下一步配色/排版/玻璃质感)。其次特效、手感。
4. 改完**提交并推 main**，给用户**清晰的「你该做什么」步骤**(覆盖哪些文件 / 跑哪个菜单 / 重启服务器命令)。

## 用户偏好（沟通）
- 中文；非程序员，按「具体步骤 + 截图反馈」推进；喜欢说「继续」让你自主升级。
- 大改动尽量一次做完再让测试；给清晰步骤 + 一行更新命令。
- **网页版已冻结**，只做 Unity 端。
