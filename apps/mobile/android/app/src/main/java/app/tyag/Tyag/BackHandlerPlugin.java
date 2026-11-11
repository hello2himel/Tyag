package app.tyag.Tyag;

import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Local Capacitor plugin that hands the Android system Back button/gesture to
 * the web layer instead of letting the Activity finish immediately.
 *
 * <p>Capacitor 8 core ({@link com.getcapacitor.BridgeActivity}) registers no
 * back handling of its own, so without this plugin every hardware Back press
 * closes Tyag from anywhere, even mid-flow. The web bundle needs to decide
 * first (close an open sheet, pop a hash-history entry, or ask the user whether
 * to quit), hence this small local plugin.</p>
 *
 * <p>It is intentionally a local plugin rather than the npm {@code @capacitor/app}
 * package: it adds no JS/npm dependency, it is registered in
 * {@link MainActivity#onCreate} before the bridge is created, and it ships in
 * the same APK/AAB with no extra Gradle module.</p>
 *
 * <p>JS contract (listeners are registered with
 * {@code TyagBack.addListener("backButton", ...)}):</p>
 * <ul>
 *   <li>{@code backButton} event -&gt; {@code { canGoBack: boolean }} where
 *       {@code canGoBack} is the current WebView history depth. The event is
 *       retained until consumed, so a listener that attaches late still sees
 *       the last press.</li>
 *   <li>{@code TyagBack.exitApp()} -&gt; resolves immediately and then finishes
 *       the Activity. The web layer calls it when Back is pressed on its root
 *       screen.</li>
 * </ul>
 *
 * <p>If the web layer has not registered a listener yet (cold start, JS bundle
 * not booted), Back must not be swallowed: the plugin mirrors the WebView
 * history if it can go back and otherwise finishes the Activity, which is the
 * platform default.</p>
 */
@CapacitorPlugin(name = "TyagBack")
public class BackHandlerPlugin extends Plugin {

    private static final String EVENT_BACK_BUTTON = "backButton";

    /**
     * Intercepts Back for as long as the Activity is alive. Registered with the
     * Activity as its LifecycleOwner so AndroidX removes it automatically when
     * the Activity is destroyed (enabled by default).
     */
    private OnBackPressedCallback onBackPressedCallback;

    @Override
    public void load() {
        AppCompatActivity activity = getActivity();
        if (activity == null) {
            // Should be impossible while the bridge is being created; leave the
            // platform default (finish) in place rather than crashing.
            return;
        }

        onBackPressedCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackPressed();
            }
        };

        activity.getOnBackPressedDispatcher().addCallback(activity, onBackPressedCallback);
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        // Resolve first so the JS promise settles before the Activity goes away.
        call.resolve();
        AppCompatActivity activity = getActivity();
        if (activity != null) {
            activity.finish();
        }
    }

    private void handleBackPressed() {
        WebView webView = bridge.getWebView();

        if (hasListeners(EVENT_BACK_BUTTON)) {
            JSObject data = new JSObject();
            data.put("canGoBack", webView != null && webView.canGoBack());
            // Retain the payload if the listener is unregistered concurrently,
            // matching the official @capacitor/app plugin.
            notifyListeners(EVENT_BACK_BUTTON, data, true);
            return;
        }

        // The web layer is not listening yet (JS bundle still booting): fall
        // back to native history/default instead of silently swallowing Back.
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }

        AppCompatActivity activity = getActivity();
        if (activity != null) {
            activity.finish();
        }
    }
}
