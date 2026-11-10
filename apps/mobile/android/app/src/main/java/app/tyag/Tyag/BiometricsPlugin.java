package app.tyag.Tyag;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

/**
 * Local Capacitor plugin exposing the Android biometric prompt to the web layer.
 *
 * <p>Tyag is local-first and never talks to the network; this plugin only asks
 * the OS/AndroidX biometric library to show the system biometric prompt. The app
 * password remains the only fallback: the prompt is configured with a
 * "Use password" negative button and device-credential unlocking is deliberately
 * NOT allowed.</p>
 *
 * <p>JS contract:</p>
 * <ul>
 *   <li>{@code Biometrics.isAvailable()} -&gt; {@code { available: boolean, reason: string }}
 *       where reason is one of {@code ok}, {@code none_enrolled},
 *       {@code hardware_unavailable}, {@code unsupported}.</li>
 *   <li>{@code Biometrics.authenticate()} -&gt; {@code { success: boolean, error?: string, code?: int }}.
 *       The call is always <em>resolved</em> (never rejected) so the web layer can
 *       fall back to the app password cleanly.</li>
 * </ul>
 */
@CapacitorPlugin(name = "Biometrics")
public class BiometricsPlugin extends Plugin {

    /**
     * Accept both Class 3 (strong) and Class 2 (weak, e.g. many face unlock
     * implementations). ORing the flags yields BIOMETRIC_WEAK (255), i.e. any
     * biometric, which is the intended UX for a privacy lock. Device credential
     * is intentionally excluded.
     */
    private static final int ALLOWED_AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_STRONG
                    | BiometricManager.Authenticators.BIOMETRIC_WEAK;

    // Synthetic error codes used for failures that do not come from the OS.
    private static final int CODE_AUTH_IN_PROGRESS = -1;
    private static final int CODE_NO_ACTIVITY = -2;
    private static final int CODE_PROMPT_ERROR = -3;

    /** Serializes prompt bookkeeping between the bridge thread and the main thread. */
    private final Object lock = new Object();

    /** True while a prompt is owned/reserved by this plugin (one prompt at a time). */
    private boolean promptInProgress = false;

    /** Prompt currently owned by this plugin, so it can be cancelled on destroy. */
    private BiometricPrompt activePrompt;

    /** Call waiting for the prompt result; resolved exactly once. */
    private PluginCall pendingCall;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        boolean available = false;
        String reason;

        try {
            BiometricManager manager = BiometricManager.from(getContext());
            int status = manager.canAuthenticate(ALLOWED_AUTHENTICATORS);
            switch (status) {
                case BiometricManager.BIOMETRIC_SUCCESS:
                    available = true;
                    reason = "ok";
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    reason = "none_enrolled";
                    break;
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                    reason = "hardware_unavailable";
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                case BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED:
                case BiometricManager.BIOMETRIC_STATUS_UNKNOWN:
                default:
                    reason = "unsupported";
                    break;
            }
        } catch (Exception e) {
            // Missing/disabled biometric hardware or an OS-level failure: report
            // unsupported rather than crashing the JS bridge.
            available = false;
            reason = "unsupported";
        }

        ret.put("available", available);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticate(final PluginCall call) {
        final FragmentActivity activity = getActivity();

        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            call.resolve(failure("no_activity", CODE_NO_ACTIVITY));
            return;
        }

        // One prompt at a time. A concurrent call is answered immediately with a
        // safe result so the JS bridge never hangs and the web layer can fall
        // back to the app password.
        synchronized (lock) {
            if (promptInProgress) {
                call.resolve(failure("authentication_in_progress", CODE_AUTH_IN_PROGRESS));
                return;
            }
            promptInProgress = true;
            pendingCall = call;
        }

        final Executor executor = ContextCompat.getMainExecutor(getContext());
        activity.runOnUiThread(() -> {
            try {
                if (activity.isFinishing() || activity.isDestroyed()) {
                    finishFailure("no_activity", CODE_NO_ACTIVITY);
                    return;
                }

                // BiometricPrompt silently drops the request when the
                // FragmentManager state is already saved (and would leave our
                // promise hanging forever), so fail the same way here.
                if (activity.getSupportFragmentManager().isStateSaved()) {
                    finishFailure("activity_not_resumed", CODE_NO_ACTIVITY);
                    return;
                }

                BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Unlock Tyag")
                        .setSubtitle("Confirm it's you to open your private records.")
                        // The only fallback is the in-app password, never the
                        // device lock-screen credential.
                        .setNegativeButtonText("Use password")
                        .setAllowedAuthenticators(ALLOWED_AUTHENTICATORS)
                        .setConfirmationRequired(false)
                        .build();

                BiometricPrompt prompt = new BiometricPrompt(
                        activity,
                        executor,
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(
                                    @NonNull BiometricPrompt.AuthenticationResult result) {
                                finishSuccess();
                            }

                            @Override
                            public void onAuthenticationError(
                                    int errorCode, @NonNull CharSequence errString) {
                                finishFailure(mapErrorMessage(errorCode), errorCode);
                            }

                            @Override
                            public void onAuthenticationFailed() {
                                // A single non-matching sample: the system prompt
                                // stays visible and lets the user retry. Do not
                                // resolve and do not log biometric data.
                            }
                        });

                synchronized (lock) {
                    if (!promptInProgress || pendingCall == null) {
                        // Activity teardown already resolved the pending call.
                        return;
                    }
                    activePrompt = prompt;
                }

                // We are on the main thread and teardown/callbacks also run on
                // the main thread, so the prompt cannot be cancelled between the
                // bookkeeping above and this call.
                prompt.authenticate(promptInfo);
            } catch (Exception e) {
                // e.g. FragmentManager state changed; fail safe so the web layer
                // can unlock with the app password.
                finishFailure("biometric_unavailable", CODE_PROMPT_ERROR);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        BiometricPrompt prompt;
        synchronized (lock) {
            prompt = activePrompt;
            activePrompt = null;
        }
        if (prompt != null) {
            try {
                prompt.cancelAuthentication();
            } catch (Exception ignored) {
                // Prompt already dismissed; nothing to cancel.
            }
        }
        finishFailure("activity_destroyed", CODE_NO_ACTIVITY);
        super.handleOnDestroy();
    }

    /** Resolves the pending call with {@code { success: true }} exactly once. */
    private void finishSuccess() {
        PluginCall call;
        synchronized (lock) {
            if (!promptInProgress) {
                return;
            }
            promptInProgress = false;
            activePrompt = null;
            call = pendingCall;
            pendingCall = null;
        }
        if (call == null) {
            return;
        }
        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }

    /** Resolves the pending call with a failure payload exactly once. */
    private void finishFailure(String error, int code) {
        PluginCall call;
        synchronized (lock) {
            if (!promptInProgress) {
                return;
            }
            promptInProgress = false;
            activePrompt = null;
            call = pendingCall;
            pendingCall = null;
        }
        if (call == null) {
            return;
        }
        call.resolve(failure(error, code));
    }

    private static JSObject failure(String error, int code) {
        JSObject ret = new JSObject();
        ret.put("success", false);
        ret.put("error", error);
        ret.put("code", code);
        return ret;
    }

    /**
     * Maps the OS error code to a stable, non-localized string the web layer can
     * branch on. The numeric code is passed through unchanged so callers can
     * also distinguish e.g. temporary lockout from permanent lockout.
     */
    private static String mapErrorMessage(int errorCode) {
        switch (errorCode) {
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
                return "user_requested_password";
            case BiometricPrompt.ERROR_USER_CANCELED:
                return "user_canceled";
            case BiometricPrompt.ERROR_CANCELED:
                return "canceled";
            case BiometricPrompt.ERROR_LOCKOUT:
                return "lockout";
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return "lockout_permanent";
            case BiometricPrompt.ERROR_NO_BIOMETRICS:
                return "none_enrolled";
            case BiometricPrompt.ERROR_HW_UNAVAILABLE:
            case BiometricPrompt.ERROR_HW_NOT_PRESENT:
                return "hardware_unavailable";
            case BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED:
                return "security_update_required";
            case BiometricPrompt.ERROR_TIMEOUT:
                return "timeout";
            default:
                return "authentication_error";
        }
    }
}
