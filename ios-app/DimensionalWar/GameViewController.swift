import UIKit
import WebKit

/// 全屏 WebView 承载游戏，断网/加载失败时显示重试界面
class GameViewController: UIViewController, WKNavigationDelegate {
    private var webView: WKWebView!
    private let retryButton = UIButton(type: .system)
    private let statusLabel = UILabel()

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.047, green: 0.047, blue: 0.114, alpha: 1)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        view.addSubview(webView)

        statusLabel.text = "🌌 连接次元中…"
        statusLabel.textColor = .white
        statusLabel.textAlignment = .center
        statusLabel.frame = view.bounds
        statusLabel.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(statusLabel)

        retryButton.setTitle("⚔️ 重新连接", for: .normal)
        retryButton.titleLabel?.font = .boldSystemFont(ofSize: 20)
        retryButton.isHidden = true
        retryButton.frame = CGRect(x: 0, y: view.bounds.midY + 30, width: view.bounds.width, height: 44)
        retryButton.autoresizingMask = [.flexibleWidth, .flexibleTopMargin, .flexibleBottomMargin]
        retryButton.addTarget(self, action: #selector(loadGame), for: .touchUpInside)
        view.addSubview(retryButton)

        loadGame()
    }

    @objc private func loadGame() {
        retryButton.isHidden = true
        statusLabel.text = "🌌 连接次元中…"
        statusLabel.isHidden = false
        webView.load(URLRequest(url: Config.gameURL, timeoutInterval: 15))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        statusLabel.isHidden = true
        retryButton.isHidden = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError()
    }

    private func showError() {
        statusLabel.text = "⚠️ 无法连接服务器，请检查网络"
        statusLabel.isHidden = false
        retryButton.isHidden = false
    }
}
