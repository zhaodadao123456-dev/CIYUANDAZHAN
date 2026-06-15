# CLAUDE.md — 次元大战（Dimensional War）项目上下文

> 这个文件会被 Claude Code 在**每个新会话开始时自动读取**。换对话/换窗口继续开发时，
> 上下文不会丢——只要内容已提交到仓库。**改动较大时，请顺手更新本文件的「当前状态/路线图」。**

## 一句话简介
「次元大战」是一个多人在线动作 RPG（5 个次元、5 个职业、实时战斗、世界BOSS、PvP 重叠战场、
每晚五次元大混战）。一套权威服务器 + 两个客户端：**网页版（Three.js，主力、最完善）** 和
**Unity 原生客户端（出 iOS/安卓/PC 包）**，二者连同一台服务器、共用同一份玩家存档（按昵称）。

## 仓库结构（重点只看前两个）
- `dimensional-war-3d/` — **主项目**：Node.js 权威服务器(`server.js`) + 网页版前端(`public/`)。玩家实际在玩这个。
- `unity-client/` — Unity 原生客户端（连同一服务器）。
- `dimensional-war-online/`、`dimensional-war/` — 早期 2D/单机版本，基本不动。
- `docs/premium-assets.md` — 购买美术热替换说明（网页版用）。

## 开发 / 测试 / 部署
- **冒烟测试（每次改服务器/网页务必跑，必须全绿）**：
  ```bash
  cd dimensional-war-3d && rm -f players.json && node smoke-test.js
  ```
  目前 **34/34 通过**。测试用环境变量加速：`DW_BOSS_MS`(BOSS刷新)、`DW_BOSS_HP`、`DW_LAIR_R`(巢穴距离)、`DW_MELEE_NOW=1`、`DW_MELEE_MS`。
- **语法检查**：`node --check server.js`、`node --check public/js/game.js`。
- **服务器部署（用户在腾讯云跑这条更新+重启，端口 80）**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/zhaodadao123456-dev/CIYUANDAZHAN/main/dimensional-war-3d/deploy/quickstart.sh | bash
  ```
- **网页版玩**：浏览器 / iPhone Safari 打开 `http://<服务器IP>`（可"添加到主屏幕"当 App）。
- **Unity 客户端更新**：用户重下仓库 ZIP，覆盖 `unity-client/Assets/Scripts` 和 `unity-client/Packages/manifest.json`（改了包依赖时）；不要覆盖整个 Assets（会删掉用户买的角色包，那些不在仓库里）。

## 约定（重要）
- 提交信息结尾必须带：`https://claude.ai/code/session_01NaWopDCG3d65MiQHLnzuum`（沿用即可）。
- 开发分支历史上用过 `claude/...`，目前直接提交并推 `main`。先提交/推送，未提交的会随容器回收丢失。
- **不要**把模型标识、`[1m]` 等写进任何提交/代码/文档。
- C# 在 `using System;` 下别用裸 `Object.Destroy`（与 System.Object 冲突）→ 用 `Destroy(...)`。
- 改完 Unity 文件用大括号配平自检：`{ 数量 } 应等于 } 数量`。
- **Unity 端 UGUI/IMGUI 文本不要用 emoji**：动态 CJK 系统字体（PingFang/雅黑等）不含 emoji 字形，会显示成空方块/消失（如 🎒🚪💰🌀）。用中文文字或程序化 SDF 图标代替。注意服务器下发的 feed/toast 文本若含 emoji，在 Unity 端也会缺字（网页端正常）——属已知遗留。

## 服务器架构（`dimensional-war-3d/server.js`，权威）
- WebSocket `/ws`，客户端发 `{t:...}` 消息；服务器 ~20Hz tick、~10Hz 快照(`snap`)。
- 房间：5 个次元各一张图 + `war`(重叠战场) + `melee`(大混战)。
- 数据定义在 `public/js/data.js`（DIMENSIONS/CLASSES/RARITIES/LAIR_ANGLES/MAP_HALF=210/LAIR_R=174），**服务器与网页前端共用此文件**。Unity 端有各自的 `DWData.cs`（数值需手动同步，如 MapHalf）。
- 已实现系统：5职业(技能basic/q/e/r，**无上限**升级)、**次元专属技能**(F键：科技护盾/修仙回血/赛博闪现/魔法禁锢/猎人捕宠)、装备(掉落/商店/强化+1~20/融合/词缀/可装备成就)、药剂(商店买、H喝、含自动复活)、**世界BOSS**(多阶段+预警圈`warn`后落地判定+5技能含大范围魔法风暴)、怪物(等级1~100、精英怪远程/范围技、按次元染色)、**重叠战场**(双次元PvP)、**每晚21点五次元大混战**(battle royale,存活最多次元得传说奖)、组队(共享经验)、成就、PvP段位天梯、**障碍物碰撞**(服务器生成圆形障碍`obstacles`,玩家+怪物都挡,发给客户端渲染)、每日签到。
- 战场/混战中**死亡不能原地复活**，回本次元复活。
- 关键消息：`welcome/you/snap/cast/proj/dmg/heal/mdie/pdie/lvl/feed/chat/ach/party/pinvite/boss/baoe/maoe/bstorm/warn/dimfx/rooted/war/melee/rank/...`

## 网页客户端（`dimensional-war-3d/public/`）
- `index.html` + `js/game.js`(主逻辑) + `js/models.js`(Three.js + KayKit GLB 模型/动画/场景道具，自带程序化兜底 + premium 热替换) + `js/data.js` + `js/audio.js` + `style.css`(已做玻璃拟态整体 UI 升级)。
- 已较完善：3D 战斗、虚拟摇杆、所有面板/图标/血条齐全。**目前体验最好的客户端。**

## Unity 客户端（`unity-client/`）
- Unity **2022.3 LTS**（标准 Unity，非"团结引擎"）。`Packages/manifest.json` 含完整内置模块 + `com.unity.cloud.gltfast`(读 .glb) + `com.unity.ugui`(UGUI)。
- 自启动：`DWGame` 用 `[RuntimeInitializeOnLoadMethod]` 引导，**无需配置场景**（出包用菜单④/⑤ 自动建空场景+导出 Xcode 工程）。
- **服务器地址写死**在 `DWGame.DEFAULT_SERVER` 常量（玩家不填 IP，登录界面已去掉 IP 框）；**首次填名+选次元职业后存档，再次启动自动登录跳过填写**（连不上才回登录界面；游戏内「退出」可回登录界面改）。
- 脚本（都在 `Assets/Scripts/`，`partial class Game`）：
  - `DWGame.cs` — 主逻辑/网络消息/移动/相机/实体/模型加载(`MakeHero`按次元×职业、`MakeCreature`怪物/BOSS、`BuildWorld`场景+渐变天空盒+哑光地面)/碰撞。
  - `DWHud.cs` — **旧 IMGUI**，现仅剩：虚拟摇杆、聊天输入(`GuiChat`)。登录/状态/技能/面板/名牌/飘字等全部已迁 UGUI（`GuiSkillBar/GuiPanel/GuiDeath/GuiMenu` 等为死代码，未删）。
  - `DWUguiHud.cs` — **新 UGUI**（Canvas+CanvasScaler 1920×1080）：状态栏/血条经验条、技能栏(6格图标按钮+环形CD+加点，**图标为程序化 SDF 字形**：箭头=远程/圆环=范围/十字=治疗/折线=突进/斜斩=近战/八角星=次元技，按 `kind` 生成 Texture2D 缓存)、大攻击键、横幅(战场/BOSS/混战)、信息流、升级/提示/死亡、🎒/🚪、背包/商店/属性滚动面板(**装备按部位画 SDF 字形**：剑/盔/盾/靴/项链，底色=品质色)、**队伍小血条(左侧池化5格)**、**小地图(左下角 RawImage+每帧重绘 Texture2D：障碍/安全区/巢穴方向/怪物BOSS/敌我玩家/自己)**、**头顶名牌(独立世界画布 sortingOrder=5，逐帧 WorldToScreenPoint 投影，名字+填充血条，BOSS加大；友/敌/怪/宠色区分)**、**伤害/治疗飘字(屏幕空间 `UiFloat` 上飘淡出)**、**登录/连接界面(独立菜单画布 sortingOrder=30，`InputField`+次元/职业选择按钮+降临，替代 IMGUI `GuiMenu`)**。
  - `DWData.cs` `DWNet.cs` `DWAudio.cs`(CC0 音频，M 键静音) `DWGame`内动画驱动 `DWAnimDriver`。
  - `Editor/DWSetupWizard.cs` — 菜单「次元大战 → ① 生成资源清单 / ② 一键接入已购模型」：扫描全工程角色，**小丑(LittleWitch1)→世界BOSS**、**骷髅→怪物池(DWMobs)**、其余人物→**按「次元×职业」各配不同模型**(生成 `DW/hero_{dim}_{cls}` 25格，用上所有角色；偏好表如 修仙奶妈=兔女郎、修仙战士=悟空、魔法奶妈=修女、猎人弓手=牛仔；其余轮流补满) + 英雄池(DWHeroes)兜底、静态道具→场景池(DWScene 给地图)。排除 URP/HDRP 变体(内置管线会变粉)、残缺部件、**特效/粒子预制体(IsEffectPrefab，防 FX_Waterfall 混进英雄)**，优先 .prefab、折叠颜色变体。①清单还会列出特效预制体路径。**Hovl 特效接入改为独立菜单「③ 接入Hovl特效」(opt-in)——它在内置管线常变粉，所以②不再自动复制**；运行时 `SpawnFx` 用 `FxBroken` 检测 shader 不可用(变粉)就跳过、改用程序化特效。**③ 还会成批复制特效池**(fxp_slash/aoe/cast/buff)，运行时按「次元+职业+技能」散列各取不同特效→每技能特效尽量不同。场景道具扫描已放宽关键词(工业 RPG_FPS/自然 SimpleNature/PurePoly 都纳入)、上限提到 80，尽量用上所有道具包。
  - `Editor/DWiOSPostBuild.cs` — iOS 打包自动放行明文 ws://（否则真机连不上服务器）。
- `Assets/Resources/`：`DWMon`(KayKit 怪物 glb)、`DWProps`(KayKit 场景 glb)、`DWAudio`(音频)、**`DWIcons`(game-icons.net 白色 PNG 图标，CC BY，运行时着色；技能/装备/背包/退出/攻击)**；向导生成 `DW`(hero_/mon_boss)、`DWHeroes`、`DWMobs`、`DWScene`、`DWFx`(Hovl 特效，运行时 `FxPrefab/SpawnFx` 按名加载，缺失则程序化兜底)。
- 用户已买的资源包（不在仓库，在用户本地 Assets/）：悟空、半血男女/教会侍从、女巫、牛仔女警长、修女、兔女郎、小丑(LittleWitch1)、骷髅合集、科幻士兵、黑暗地牢(场景)、**Pure Poly 终极低多边形自然包(场景，已用于 DWScene)**、**Hovl Studio 特效(AAA Projectiles/AOE Magic spells/Magic circles/3D Lasers，已接入 DWFx)**、RPG_FPS 工业道具、MapMagic(地形工具,未用,与平面坐标冲突)、各种武器包。

## 当前状态 / 路线图（改动后请更新这里）
- ✅ 服务器全部玩法系统完成；冒烟测试 34/34。
- ✅ 网页版功能 + UI 完善（玩家可在 iPhone Safari 直接玩，体验最好）。
- ✅ Unity 客户端：连服务器、模型一键接入、碰撞、横屏、音效；**UI 已全面迁到 UGUI（含队伍血条、小地图、头顶名牌血条、伤害飘字、登录界面）**，IMGUI 仅剩虚拟摇杆 + 聊天输入。技能/装备图标均为程序化 SDF 字形。
- ✅ 美术接入：Pure Poly 自然包铺满地图(向导场景池)、五次元专属英雄(含猎人←牛仔)、**Hovl 特效已接到技能/弹道/击中/BOSS范围技/次元技**(程序化兜底)；战斗程序特效(地面光环/火花/拖尾)亦在。
- ⏳ **待办**：Unity UGUI 布局需按真机截图**微调坐标/大小/锚点**（盲改，未预览，队伍条/小地图同样需校准）；**Hovl 特效在用户项目里变粉（shader 与内置管线不兼容/未导入）——删 `Resources/DWFx` 即回退到「按次元配色」的程序化特效（不粉、已够好看）**；Hovl 若修好 shader 可享次元元素变体；**技能/装备/背包/退出/攻击图标已换 game-icons.net 真图标(白图运行时着色，缺失回退 SDF)**；用户在做 iOS 真机 Xcode 打包。
- 🔧 移动端优化：小地图限 ~12.5Hz 重绘；头顶名牌仅在等级变化时重建文本（省每帧字符串分配）；地面改为**程序化网格纹理**（灰度白底×次元色，每5米一格，不再是纯色大平面）；`Awake` 清运行时图标/特效/贴图缓存（防关 Domain Reload 时引用旧对象）。技能特效按次元配色（科技蓝/修仙绿/赛博粉/魔法紫/猎人橙）+ 按 kind 变形。
- ❌ 暂不做：MapMagic 3D 地形（与"服务器 2D 平面坐标、脚踩 y=0"冲突，会悬空/陷地，需大改才行）。

## 用户偏好（沟通）
- 用户用中文；非程序员，按"具体步骤 + 截图反馈"推进。喜欢"继续/继续改"让我自主升级。
- 大改动尽量一次做完再让用户测试；改完给出"用户该做什么"的清晰步骤 + 一行更新命令。
- **网页版已冻结**：用户明确表示网页版以后不用再管，新功能/打磨只做 Unity 端。
