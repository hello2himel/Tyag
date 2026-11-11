package app.tyag.Tyag;

import android.graphics.Color;
import android.os.Bundle;

import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (non-npm) Capacitor plugins must be registered before the
        // bridge is created by super.onCreate().
        registerPlugin(BiometricsPlugin.class);
        // Routes the system Back button/gesture to the web layer ("TyagBack"
        // JS plugin) instead of finishing the Activity from anywhere.
        registerPlugin(BackHandlerPlugin.class);
        super.onCreate(savedInstanceState);

        // Edge-to-edge: let the app draw underneath the status bar and the
        // navigation/gesture bar so the web canvas — not a system surface — is
        // what shows behind them.
        //
        // This runs AFTER super.onCreate() on purpose. BridgeActivity applies
        // AppTheme.NoActionBar (setTheme + setContentView) inside its own
        // onCreate; enabling edge-to-edge before that would install the decor
        // under the transient launch/splash theme instead of the app theme.
        //
        // Both bars use fully transparent scrims ("auto" keeps the light/dark
        // appearance detection, transparent both ways) rather than
        // androidx.activity's default navigation-bar scrims: the design owns
        // the full canvas and the Capacitor 8 SystemBars plugin re-tints the
        // bar icons from the resolved in-app theme (see
        // apps/web/src/store/app.tsx). EdgeToEdge also disables status- and
        // navigation-bar contrast enforcement on API 29+, which would
        // otherwise paint a system scrim behind the gesture pill.
        //
        // `windowBackground` is the colour the Capacitor SystemBars fallback
        // (WebView < 140) shows in the padded bar area, so it follows day/night
        // via res/values/colors.xml + res/values-night/colors.xml.
        EdgeToEdge.enable(
            this,
            SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT)
        );
    }
}
