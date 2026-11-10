/**
 * Optional native biometric unlock (Android). The native side is a small local
 * Capacitor plugin (`Biometrics`, see apps/mobile/android/.../BiometricsPlugin
 * .java) that shows the system BiometricPrompt. Everywhere else this is
 * unavailable and the app password remains the only unlock method.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface BiometricsPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  authenticate(): Promise<{ success: boolean; error?: string; code?: number }>;
}

const Biometrics = registerPlugin<BiometricsPlugin>('Biometrics');

export interface BiometricAvailability {
  available: boolean;
  reason?: string;
}

export function biometricsSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function biometricsAvailable(): Promise<BiometricAvailability> {
  if (!biometricsSupported()) return { available: false, reason: 'unsupported' };
  try {
    const result = await Biometrics.isAvailable();
    return { available: Boolean(result.available), reason: result.reason };
  } catch {
    return { available: false, reason: 'unavailable' };
  }
}

export async function authenticateBiometrics(): Promise<{ success: boolean; error?: string }> {
  if (!biometricsSupported()) return { success: false, error: 'Biometric unlock is available in the Android app only.' };
  try {
    return await Biometrics.authenticate();
  } catch {
    return { success: false, error: 'Biometric unlock is unavailable right now. Use your password.' };
  }
}
