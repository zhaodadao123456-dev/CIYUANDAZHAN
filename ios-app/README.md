# 📱 次元大战 · iOS 原生 App（App Store 上架版）

这是一个完整的 Xcode 工程：原生 iOS 应用，启动后全屏加载你的游戏服务器（横屏、无地址栏、断线自动提示重连）。

## 0. 你需要准备

| 条件 | 说明 |
|------|------|
| 一台 Mac | 安装最新版 Xcode（App Store 免费下载） |
| Apple 开发者账号 | https://developer.apple.com 注册，**99 美元/年**（个人账号即可） |
| 游戏服务器在运行 | 即腾讯云上部署好的 dimensional-war-3d |

## 1. 打开工程并改服务器地址

1. 在 Mac 上克隆本仓库，双击 `ios-app/DimensionalWar.xcodeproj` 打开
2. 打开 `DimensionalWar/Config.swift`，把 `http://1.2.3.4` 改成你的服务器公网 IP（或域名）
3. 左侧点蓝色工程图标 → TARGETS「DimensionalWar」→ **Signing & Capabilities**：
   - Team 选你的开发者账号（首次需 Xcode → Settings → Accounts 登录 Apple ID）
   - Bundle Identifier 改成你自己的，如 `com.你的名字.dimensionalwar`

## 2. 先真机试玩（不用花钱）

用数据线连上 iPhone → Xcode 顶部设备选你的手机 → 点 ▶ 运行。
免费 Apple ID 也能装到自己手机上试玩（签名 7 天有效，重新运行即可续）。

## 3. 上架 App Store

1. Xcode 菜单 **Product → Archive**（设备选 Any iOS Device）
2. 弹出的 Organizer 窗口点 **Distribute App → App Store Connect → Upload**，一路下一步
3. 打开 https://appstoreconnect.apple.com → 我的 App → ➕ 新建 App，填写：
   - 名称：次元大战 ／ 类别：游戏
   - 截图（用模拟器或手机截游戏画面）、描述、隐私政策网址
   - 构建版本：选择刚上传的包
4. 提交审核，一般 1～3 天出结果

## 4. 上架前强烈建议：服务器换成 HTTPS 域名

目前 App 用 `http://IP` 直连，工程里临时放开了 ATS（Info.plist 中的
`NSAllowsArbitraryLoads`）。苹果审核可能因此提问或拒绝。正式上架前：

1. 买个域名并解析到服务器 IP
2. 服务器上用 Caddy 或 Nginx + Let's Encrypt 免费证书开启 HTTPS
3. `Config.swift` 改成 `https://你的域名`，并删除 Info.plist 里的 `NSAppTransportSecurity` 整段

## ⚠️ 中国大陆区的特别说明（重要）

在**中国大陆区** App Store 上架对"游戏"类有两道硬门槛：

- **游戏版号**：国家新闻出版署的网络游戏出版审批，个人开发者基本无法取得
- **ICP 备案**：2023 年起所有中国区上架 App 都要求工信部备案

**可行做法**：上架时在 App Store Connect 的"定价与销售范围"里**去掉中国大陆**，
只上架港澳台/海外区域（无需版号）。国内朋友继续用网页版/PWA 玩，完全不受影响。

## 审核小贴士

- 纯 WebView 套壳有被 4.2（最低功能要求）拒审的风险；游戏类通常宽松，
  但审核备注里写清楚"这是实时多人在线游戏，服务器为自营"会更稳
- 审核期间务必保证服务器在线，审核员连不上必拒
