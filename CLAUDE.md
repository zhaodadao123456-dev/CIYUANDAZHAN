# CLAUDE.md — 次元大战（Dimensional War）项目上下文

> 本文件在**每个新会话开始时自动读取**，是项目的完整交接文档。换会话继续开发，只要已提交到仓库，上下文就不丢。
> **改动较大时请顺手更新「当前状态/路线图」。**

## 一句话简介
多人在线动作 RPG：**5 个次元 × 5 个职业**、实时战斗、世界BOSS、PvP 重叠战场、每晚五次元大混战。
一套权威服务器 + 两个客户端：**网页版（Three.js，最完善，已冻结不再开发）** 和 **Unity 原生客户端（出 iOS/安卓/PC，当前开发重点）**。两端连同一服务器、**共用玩家存档（已从「按昵称」改为「按唯一找回码 uid」，见下「存档/账号」）**。

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
- **Unity 客户端更新**：用户重下仓库 ZIP（`main`：https://github.com/zhaodadao123456-dev/CIYUANDAZHAN/archive/refs/heads/main.zip），覆盖 `unity-client/Assets/Scripts/`（含 `Editor/` 子目录 + `*.shader` 自定义 shader）+ `Assets/Resources/DWIcons/` + 改了包依赖时的 `Packages/manifest.json`；**不要覆盖整个 Assets**（会删掉用户买的、不在仓库里的角色/特效包）。覆盖后视改动重跑向导菜单②/③，再 ▶ 运行。
- **盲改铁律**：UI/3D/观感类改动这边看不到，必须靠用户**截图 + 向导日志**校准。改完给用户「下哪个链接/覆盖哪个文件夹/跑哪个菜单/看什么」的具体步骤。
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
- 已实现：5职业(basic/q/e/r，**无上限**升级)、装备(掉落/商店/强化+1~20/融合/词缀/可装备成就)、药剂(H喝/自动复活；**商店也卖药**)、**世界BOSS**(多阶段+预警圈`warn`落地判定+5技能；**body radius r=3：模型放大3倍，玩家撞不进、可从边缘打中**)、**重叠战场**双次元PvP、**每晚21点五次元大混战**、组队共享经验、成就、PvP段位天梯、**障碍物碰撞**(圆形`obstacles`，玩家+怪物都挡)、每日签到、**动作表情`emote`**(同房间广播)。
- **次元专属技能（F键，本会话全部重做，统一持续60秒/冷却5分钟，常量 `DIM_DUR=60000`/`DIM_CD=300000`）**：
  - **修仙=炼宝诀**：熔炼背包前5件装备→`p.treasure` 法宝，全属性加成 = Σ(装备属性)×等级/10，不同职业不同法宝（客户端应渲染**头顶悬浮 3D 法宝**，待办）。
  - **科技=载具冲锋**：生成 `p.vehicle{until,hp,maxHp}`，受击经 `absorbShield` **优先扣载具血**、大幅+移速、载具自带攻击（客户端待办**载具 3D 模型**）。
  - **魔法=召唤天使恶魔**：天使给己方+队友增益、恶魔给周围敌人减益（客户端待办**天使/恶魔 3D 模型**）。
  - **赛博=强化针剂**：`p.amp{until,mul}`，全属性/技能范围(cast 里 `rm`)/**体型** ×(1+等级/10)（不足1为1倍）；客户端应按下发的 `amp` **放大英雄体型**，待办。
  - **猎人=捕宠强化**：捕捉更难(ratio>0.3 才可捕、几率 `min(0.6,0.65-ratio*1.6)`)；吃药同时**给宝宝回血**；**新宝宝与上一只属性融合**(叠加)。
  - 实现要点：`mergeBuff`、`statsOf` 里乘 amp/treasure 加成、`absorbShield` 先吃 vehicle 血。
- **怪物（本会话大改）**：**近战+远程混合**(约40%远程弹幕)、**每10只1个精英**(`monSpawnCount`计数；属性×2.6/攻×1.7/技能更频)、整体血攻大幅提高、**等级随离出生点距离平滑增长**(`frac=clamp((r-55)/(MAP_HALF-55))`)、**脱战回满血**、`snapRow` 下发 `mo.elite`(客户端精英视觉待办)。
- **经济/难度再平衡（本会话）**：升级经验 `expNeed ×3`、野怪金币 `/3`、掉装几率 `/3`、商店售价 `prices=[3500,9000,22000]`(原×10)。
- **存档/账号（本会话改造，存服务器 `players.json`）**：主键从昵称→**唯一找回码 uid `DWxxxxxxx`**（`uniqCode` 生成、`saved` 按 uid、`nameIndex` 兼容老昵称登录、`migrateSaved` 迁移老档）。`welcome` 下发 `code:p.uid`，客户端存本机自动登录；可输码换设备找回。混战/排行/签到均按 uid。**昵称改名功能待加**（拟 `rename` 消息）。存等级/经验/金币/装备/技能点/成就/宝宝等。
- 战场/混战中**死亡不能原地复活**，回本次元复活。
- 关键消息：`welcome(含code)/you/snap(含mo.elite)/cast/proj/dmg/heal/mdie/pdie/lvl/feed/chat/ach/party/pinvite/boss/baoe/maoe/bstorm/warn/dimfx/rooted/war/melee/rank/emote/...`

## 网页客户端（`dimensional-war-3d/public/`）— 已冻结
- `index.html` + `js/game.js` + `js/models.js`(Three.js+KayKit GLB) + `js/data.js` + `js/audio.js` + `style.css`(玻璃拟态)。功能/UI 完善，**用户已明确不再开发网页版**。

## Unity 客户端（`unity-client/`）— 当前开发重点
- Unity **2022.3 LTS**（标准 Unity，**内置渲染管线 Built-in**，非 URP/HDRP）。`Packages/manifest.json` 含内置模块 + `com.unity.cloud.gltfast`(.glb) + `com.unity.ugui` + `com.unity.nuget.newtonsoft-json`。
- 自启动：`DWGame` 用 `[RuntimeInitializeOnLoadMethod]` 引导，无需配置场景。
- **登录**：服务器IP 写死在 `DWGame.DEFAULT_SERVER`(="119.45.129.74")，玩家不填 IP；登录界面填**昵称+选次元+选职业（+找回码框待加）**。客户端存服务器下发的 `code`(playerCode/recoverCode/pendingCode)、`Join(bool auto)` 自动登录；**首次降临后自动登录跳过填写**（连不上才回登录界面；「退出」回登录可改昵称）。
  - **⏳ 登录界面重做（用户已选方案A，未动工）**：准备界面**左右分屏**——右=输入账号/找回码+选次元+选职业；左=**当前所选英雄 3D 预览**(可拖动旋转/缩放查看)。
- 脚本（都在 `Assets/Scripts/`，`partial class Game`）：
  - `DWGame.cs` — 主逻辑/网络/移动/相机/实体/模型加载(`MakeHero` 按 `hero_{dim}_{cls}`→`hero_{dim}`→池→占位；`MakeCreature(tier,level,id)` 怪物/BOSS，BOSS×3，**怪物体型随 level 放大**`1+Clamp01(level/100)*0.9`；`BuildWorld` 程序化网格地面+渐变天空盒+散布道具)/碰撞/**全部战斗特效**(见下)/`DWAnimDriver`(`SetBase/PlayOnce/Apply`)。
    - **相机（本会话调）**：`CamPitch0=0.5/CamDist0=7.5`、`ResetCamera()`（HUD 有「视角」复位键）；缩放联动焦点(`UpdateCamera` 里 `zt/lookY/baseY`)——**拉远压低看全身、拉近怼脸看脸**；pitch 0.1~1.4、dist 1.4~16、双指捏合缩放。
    - **光照（本会话调）**：环境光中性 `ambientLight=(0.74,0.75,0.77)`（**不再叠次元主题色**，修角色发灰发绿）+ 主光 1.05 + 柔和补光 0.45。
    - **地图道具修色（本会话）**：`FixPinkMaterials` 用 `DW/VertexColor`、不叠主题色；运行时白模兜底 `whiteFlat`/`NaturalColor(name)`。道具真彩主要靠向导②（见下）。
    - **动作表情（本会话）**：收 `emote` 在对应玩家 `DWAnimDriver.PlayOnce` 播放；本地点动作同时 `Send{t:"emote"}`。
  - `DWUguiHud.cs` — **UGUI HUD**（Canvas 1920×1080）：状态栏/血条经验条、技能栏(6格)、大攻击键、横幅、信息流、升级/提示/死亡、背包/**商店(含买药区)**/属性面板、队伍小血条、**小地图**、**头顶名牌血条**、**伤害飘字**、**登录界面**、**「视角」复位键 + 「动作」表情键**(弹 7 个动作面板)。图标优先用 `DWIcons` 真图标(白图运行时着色)缺失回退程序化 SDF。**面板/按钮已圆角化**(`RoundSprite` 9-slice)。
  - `DWHud.cs` — 旧 IMGUI，**现仅剩虚拟摇杆 + 聊天输入**；其余为死代码未删。
  - `DWData.cs` `DWNet.cs` `DWAudio.cs`(CC0，M静音)。
  - **自定义 shader（本会话新增，在 `Assets/Scripts/`）**：`DWVertexColor.shader`(`DW/VertexColor`：顶点色×贴图×_Color，近黑顶点色按白处理) 修低多边形道具；`DWDoubleSided.shader`(`DW/DoubleSided`：Cull Off) 修狐妖衣服布料破洞。
  - `Editor/DWSetupWizard.cs` — 菜单「① 生成资源清单 / ② 一键接入已购模型 / ③ 接入Hovl特效」。详见下「向导」。
  - `Editor/DWiOSPostBuild.cs`(ATS放行) `Editor/DWBuildIOS.cs`(④/⑤ 一键出 iOS)。
- `Assets/Resources/`：`DWMon`(KayKit怪物glb) `DWProps`(KayKit场景glb) `DWAudio` `DWIcons`(game-icons.net CC BY 白图)；**向导生成**：`DW/`(hero_{dim}_{cls} 25个 + hero_{dim} + mon_boss) `DWHeroes` `DWMobs` `DWScene` `DWFx`(Hovl特效，运行时按名/池加载，缺失/变粉则程序化兜底)。

### 向导（DWSetupWizard）做什么
- **角色**：小丑(LittleWitch1)→世界BOSS(Generic骨骼用自带动作)；骷髅→怪物池；其余人物→**按「次元×职业」分配 25 个 `hero_{dim}_{cls}`**，用上所有角色。偏好表(可加)：修仙·刺客=**狐妖(huli/fox)**、修仙·奶妈=兔女郎、魔法·奶妈=修女、魔法·战士=半血、猎人·弓手=牛仔、科技/赛博·战士=士兵妹v1/v2；其余从角色库轮流补满。排除 URP/HDRP 变体(内置管线变粉)、残缺件、特效/粒子预制体(`IsEffectPrefab`)、**`.blend`**(149MB 狐狸源文件含2个mesh→只用 `.fbx`)。
- **狐妖(huli)专门处理（本会话）**：`ApplyHuliMaterial` 从散图建 Standard 材质(BaseColor sRGB、Normal NormalMap、`RepackMetalRough` 把 glTF 的 G=粗糙/B=金属 重打包成 Unity R=金属/A=光滑)，用 `DW/DoubleSided`(修衣服破洞)，贴到 `hero_xiuxian_assassin`。**动画混合**`BuildController(wukong,huli)`：战斗+走跑(Run/Attack1/Attack2/Skill/Skill2)用**悟空**，其余(Idle/Dodge/Death)用**狐狸**。
- **场景道具**(DWScene)：关键词白名单(自然/通用/工业)，**排除武器/地形大块/主题杂物/建筑墙路**；上限 80。`BuildWorld` 在障碍点 + 额外 110 个随机散布，铺满地图。
- **道具真彩恢复（本会话，关键）**：用户的 Pure Poly 道具是 URP 材质(内置管线变 InternalErrorShader/粉)，用**调色板贴图**`PP_Color_Palette`(256×256，颜色在第一套 UV)。`RecoverProps`：用 `SerializedObject` 从坏材质的 `m_SavedProperties` 读回原贴图(`MatTex`)/颜色(`MatColor`)，换成 `DW/VertexColor`；**`EnsurePaletteImport` 把调色板贴图强制 sRGB + 点采样(Point) + 关 mipmap**——否则 mipmap/双线性会把小色块混成一片灰白(用户「道具发白」就是这个)。日志打印 `首个道具诊断:`(贴图名/尺寸/有无第二套UV/原shader)。若日志 `有第二套UV=True` 才需改 shader 取 UV1；目前用户日志=False，已确认 sRGB+点采样修复对路。
- **③ Hovl 特效**(opt-in，因内置管线常变粉)：复制命名特效 + **特效池**(`fxp_slash` 整包剑斩 / `fxp_aoe` / `fxp_cast` / `fxp_buff`) + **次元元素池**(`fxp_cast_{dim}`、`fxp_aoe_{dim}`)到 `Resources/DWFx`。

### 战斗特效系统（DWGame，关键设计）
- **取用优先级**：`SpawnPoolFx(cat,dim,seed)` 先取次元元素池 `fxp_{cat}_{dim}` → 通用池 `fxp_{cat}` → `SpawnFx` 命名 Hovl → **程序化兜底**。`FxBroken` 检测 shader 不可用(变粉)就跳过。
- **按技能类型 + 次元元素匹配**：近战/突进→剑斩(整包散列)；远程→该次元元素施法闪光；范围→该次元元素范围魔法(科技闪电/赛博飞刀/修仙自然/魔法能量/猎人陨石)；治疗→魔法阵。`seed=hash(dim+cls+key)` 让**每个次元每个英雄每个技能特效尽量不同**。
- **程序化特效**(永远能渲染、不依赖素材、绝不变粉)：地面扩散光环 `SpawnShockwave`、月牙剑斩 `SpawnSlash`、火花 `SpawnSparks`(ParticleSystem)、光闪 `SpawnFlash`、弹道拖尾、按次元配色(科技蓝/修仙绿/赛博粉/魔法紫/猎人橙)。**删 `Resources/DWFx` 即全程序化。**

### 用户已买资源包（不在仓库，在用户本地 Assets/）
悟空、半血男女/教会侍从、女巫、牛仔女警长、修女、兔女郎、小丑(LittleWitch1)、骷髅合集、科幻士兵、黑暗地牢、**Pure Poly/PurePoly 终极低多边形自然包**、**SimpleNaturePack**、**RPG_FPS 工业道具**、**Hovl Studio 特效**(AAA Projectiles / AOE Magic spells / Magic circles / 3D Lasers / **Sword slash VFX** / RPG VFX Bundle)、PlasmaWeaponVol1(武器,未接)、MapMagic(地形工具,**不用**)、各种武器包。

## 当前状态 / 路线图（改动后请更新；详细需求清单见 `BACKLOG.md`）
### ✅ 本会话已上线 main（冒烟均 34/34）
- **服务器**：①账号改造(昵称→唯一找回码 uid，自动迁移老档)；②经济再平衡(升级×3、金币/掉装难度×3、售价×10)；③**5 个次元技能全部重做**(炼宝诀/载具冲锋/天使恶魔/强化针剂/捕宠融合，统一 60s/300s)；④**怪物大改**(近战+远程、每10只1精英、随距离升级、脱战回血、体型随级)；⑤商店卖药；⑥动作表情 emote 联网。
- **Unity**：①**全部图标换成 game-icons.net 真图标**(下载的 PNG，CC BY，已署名，替代旧程序化霓虹)；②**狐妖 huli** 接入修仙刺客(材质/双面/动画混合)；③相机(怼脸看脸 + 退远看全身 + 「视角」复位键)；④光照中性化(角色不发灰发绿)；⑤**地图道具真彩恢复**(DW/VertexColor + 调色板贴图 sRGB/点采样/关mipmap)——**最近一次用户日志确认下对了版本、`有第二套UV=False`，待用户进游戏视觉确认**；⑥「动作」表情键(7 动作)；⑦商店买药 UI。
- **新增自定义 shader**：`DW/VertexColor`、`DW/DoubleSided`（都在 `Assets/Scripts/`，随 Scripts 一起覆盖）。

### ⏳ 待办（用户已排优先级，多需截图校准）
0. **本地会话新增、刚入库 main（commit c405fbf，全部待用户进游戏截图确认/校准坐标）**：
   - 登录界面**左右分屏 + 左侧英雄 3D 预览**（专用相机→RenderTexture，可拖动旋转/缩放；`DWHeroPreviewInput`）+ 各次元 5 职业风格化称号 + `DWLogin/` 头像背景图（向导⑥生成、缺失程序化兜底）。
   - **次元技能 3D 表现**：炼宝诀头顶悬浮法宝、科技载具模型、魔法天使/恶魔、强化针剂按 `amp` 放大英雄体型；`CastVfx` 按范围缩放、**R/大招用更大范围特效**。
   - **技能名称/描述按次元×职业独立**（`DWData.SkillName/SkillDesc/ScaleAt` + mult/radius/pct 元数据）。
   - server.js：**退出重进保留血量+坐标**（存活且本次元正常房间才存），杜绝退出回满血+瞬移。
   - 向导新增 **「⑥ 修复地图道具颜色」** 独立菜单；按次元排除道具；`BuildController` 支持更多动画来源；`ApplyWaibangMaterial`。
1. **登录界面**（已由上方实现，待截图校准排版/坐标）+ **昵称改名功能**(服务器加 `rename`，尚未做)。
2. **精英怪 `mo.elite` 视觉区分**（次元技能 3D 表现已做，精英怪视觉仍待办）。
3. **技能特效进一步打磨（Phase 2）**：每英雄每技能尽量独立、匹配次元元素+职业，参考 LoL/魔兽/笑傲江湖。
4. **每个英雄技能独立化**：数值/手感继续按次元+职业区分（名称/描述已独立）。
5. **UI 美化下一轮**：配色/玻璃拟态/排版/描边投影/CD 反馈(圆角已做)；UGUI 坐标真机微调。
6. **遗留**：Hovl 特效在内置管线变粉(`FxBroken` 自动跳过回退程序化)；PlasmaWeapon 武器未绑手上。
- ❌ 暂不做：MapMagic 3D 地形（与「服务器 2D 平面、脚踩 y=0」冲突）；网页版（已冻结）。

## 给新会话：如何高效继续优化
1. **先读本文件 + `BACKLOG.md` 全文**，再动手。Unity 改完务必大括号配平自检；改 server.js 必跑 `cd dimensional-war-3d && rm -f players.json && node smoke-test.js`（须 34/34）。
2. **看不到 Unity 画面**——UI/观感类改动让用户**截图 + 发向导日志**再针对性调；优先「程序化兜底 + 素材可选」写法，避免单点失败/变粉。
3. **当前进度卡点**：地图道具发白——已推 `EnsurePaletteImport`(sRGB+点采样+关mipmap)修复，用户最新日志已是新版且 `有第二套UV=False`，**等用户进游戏确认颜色是否恢复**；若仍白则加运行时强制点采样兜底。确认后进「登录界面方案A」。
4. 改完**提交并推 main**，给用户**清晰的「你该做什么」步骤**(下哪个链接 / 覆盖哪个文件夹 / 跑哪个菜单 / 重启服务器命令)。

## 用户偏好（沟通）
- 中文；非程序员，按「具体步骤 + 截图反馈」推进；喜欢说「继续」让你自主升级。
- 大改动尽量一次做完再让测试；给清晰步骤 + 一行更新命令。
- **网页版已冻结**，只做 Unity 端。
