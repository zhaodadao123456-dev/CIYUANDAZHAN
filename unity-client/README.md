# 🎮 次元大战 · Unity 客户端

真正的客户端游戏版本：连接你腾讯云上的次元大战服务器（与网页版同一个世界、同一份存档），
画质和手感按客户端游戏标准逐步升级。

## 1. 安装 Unity（一次性，免费）

1. 下载 Unity Hub：https://unity.cn 或 https://unity.com/cn/download （选 macOS 版）
2. 打开 Unity Hub → 登录/注册 Unity 账号（个人版免费）
3. 安装编辑器：**Unity 2022.3.x（LTS）** 或 **Unity 6 (6000.x)** 都可以
   （unity.cn「历史Unity版本」里的 2022.3.62f3c1 即可；勾选 iOS Build Support 可以以后出 iPhone 包）
   注意：「团结引擎」是 Unity 中国的特供分支，不要选它，选标准 Unity 版本

## 2. 打开项目

1. 克隆/下载本仓库到 Mac
2. Unity Hub →「添加」→ 选择仓库里的 `unity-client` 文件夹
3. 双击打开（首次打开会自动下载依赖包，等几分钟）
4. 直接点顶部 **▶ 播放按钮**（不需要打开任何场景，游戏自动启动）

## 3. 进入游戏

- 启动后输入：服务器地址（你的腾讯云公网 IP）、昵称、选次元、选职业 → 降临次元
- 操作：WASD 移动 ｜ 右键拖动转视角 ｜ 滚轮缩放 ｜ 左键普攻 ｜ Q/E/R 技能 ｜ 空格翻滚 ｜ F 捕捉宝宝（猎人）｜ B 属性/背包/商店

进度与网页版互通（同昵称同存档），技能加点、装备、商店、宝宝全部可用。

## 4. 导入购买的美术包（变好看的关键一步）

1. 在 Unity 编辑器顶部菜单 Window → Asset Store（或 Package Manager → My Assets）
2. 下载并 Import 你购买的角色/场景包到 `Assets/` 下
3. 顶部菜单 **次元大战 → ② 一键接入已购模型(自动)**：向导会扫描全工程角色，
   按下表把购买包**精确分配到对应次元**，并自动搭好动画控制器（用悟空那套人形动作做重定向）

   | 次元 | 英雄模型来源 | 备注 |
   |------|-------------|------|
   | 修仙 | `Char_Wukong`（悟空 WukongB） | 自带整套人形动作，最佳 |
   | 西方魔法 | `Half_Blood`（半血少女/男子/教会侍从） | 人形骨骼，重定向悟空动作 |
   | 科技 | `Sci-Fi 士兵 v.1` | Generic 骨骼，向导自动转 Humanoid 后才会动 |
   | 赛博朋克 | `Sci-Fi 士兵 v.2` | 同上 |
   | 猎人 | 暂无专属包，自动借用一个人形英雄 | 买到专属包重跑 ② 即覆盖 |

   **角色多于上表时**：向导先按主题关键词精确分配已知包，再把**剩余未用到的角色**依次补给还没有专属英雄的次元，
   保证每个次元的英雄外观都不同、尽量用上所有购买角色。想精确指定某个角色到某次元，把新的资源清单发我即可。

   分配优先级（运行时 `DWGame.MakeHero`）：
   `Resources/DW/hero_{次元}_{职业}` → `hero_{次元}` → `hero_{职业}` → 角色池取模 → 占位小人。
   想给某个「次元×职业」单独换模型，只需放一个 `Resources/DW/hero_{次元}_{职业}.prefab` 即可覆盖。

4. 跑完会生成 `Assets/DW_接入结果.txt`，把它发给 Claude 可继续精调分配。
   ⚠ Sci-Fi 士兵包原本是 Generic 骨骼、没有动作，向导会自动把其 FBX 导入设置改成
   Humanoid 并重导入；个别模型若自动配骨骼失败，结果文件里会提示需手动在导入设置里配 Avatar。

## 5. 出 iPhone 包（以后）

File → Build Settings → iOS → Build，Unity 会生成 Xcode 工程，
按 `ios-app/README.md` 的签名流程上真机/上架。

## 怪物与场景（KayKit 免费素材，已内置）

`Assets/Resources/DWMon`（怪物 t1~t4）与 `Assets/Resources/DWProps`（各次元场景道具）
是网页版同款 KayKit CC0 公版模型，已随工程提供。读取 `.glb` 需要 **glTFast** 插件，
已在 `Packages/manifest.json` 声明（`com.unity.cloud.gltfast`），首次打开 Unity 会自动下载。

> 若自动下载失败：Window → Package Manager → 左上角 ➕ → Add package by name →
> 输入 `com.unity.cloud.gltfast` → Add。装好后怪物和场景即生效，否则自动回退占位方块。

## 当前状态 / 路线图

- [x] 连接服务器、多人同步、移动/技能/翻滚、自动瞄准
- [x] 职业/技能加点/装备背包商店/捕捉宝宝/重叠战场 全部界面
- [x] 断线自动重连、登录信息记忆
- [ ] 导入正式角色模型与骨骼动画（等美术包）
- [ ] 技能特效（粒子/拖尾/受击闪光）与打击感（顿帧/镜头震动）
- [ ] 音乐音效
- [ ] UGUI 正式界面美化（当前为临时 IMGUI）
- [ ] 手机虚拟摇杆 + iOS 打包
