import Foundation

/// 全局配置：上架前只需要改这里
enum Config {
    /// 游戏服务器地址。
    /// ⚠️ 把下面的 IP 换成你的腾讯云服务器公网 IP（或绑定的域名）。
    /// App Store 正式上架强烈建议换成 https:// 域名（见 ios-app/README.md 第 4 节）。
    static let gameURL = URL(string: "http://1.2.3.4")!
}
