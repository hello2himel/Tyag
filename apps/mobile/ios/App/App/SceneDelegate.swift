import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        enableSwipeBackGesture()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// iOS has no hardware Back button, so the only native "back" affordance is
    /// the WKWebView edge-swipe back/forward gesture. It is off by default;
    /// enabling it lets the web layer's history entries drive navigation, the
    /// same way the Android back button does through the TyagBack plugin.
    ///
    /// The web bundle keeps a popstate sentinel on the hash history: one swipe
    /// first pops the sentinel (closing any open overlay/sheet), and only the
    /// next swipe pops the previous route, matching the Android back behaviour.
    private func enableSwipeBackGesture() {
        guard let bridgeViewController = window?.rootViewController as? CAPBridgeViewController else { return }

        // This runs on the main thread (UISceneDelegate callbacks are main
        // thread). The bridge, and its WKWebView, are created lazily in
        // CAPBridgeViewController.loadView(); load it now so the webView is
        // guaranteed to exist before we touch it.
        bridgeViewController.loadViewIfNeeded()

        bridgeViewController.bridge?.webView?.allowsBackForwardNavigationGestures = true
    }
}
