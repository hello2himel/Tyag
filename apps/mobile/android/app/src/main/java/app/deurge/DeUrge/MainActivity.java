package app.deurge.DeUrge;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (non-npm) Capacitor plugins must be registered before the
        // bridge is created by super.onCreate().
        registerPlugin(BiometricsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
