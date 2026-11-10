/**
 * Optional local progress acknowledgement.
 *
 * - Web/PWA: the Notification API while the app is open (no push, no server).
 * - Android/iOS: Capacitor LocalNotifications, scheduled on-device.
 *
 * Progress recognition in Tyag never depends on notifications, and
 * notifications never use milestones. They are disabled by default and require
 * explicit consent.
 */
import { Capacitor } from '@capacitor/core';

export type NotificationAvailability = 'web' | 'native' | 'unsupported';

export function notificationAvailability(): NotificationAvailability {
  if (Capacitor.isNativePlatform()) return 'native';
  if (typeof Notification !== 'undefined') return 'web';
  return 'unsupported';
}

export async function requestNotificationPermission(): Promise<boolean> {
  const availability = notificationAvailability();
  if (availability === 'native') {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const result = await LocalNotifications.requestPermissions();
      return result.display === 'granted';
    } catch {
      return false;
    }
  }
  if (availability === 'web') {
    try {
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      return (await Notification.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return false;
}

export async function showProgressNotification(title: string, body: string): Promise<void> {
  const availability = notificationAvailability();
  if (availability === 'native') {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.schedule({
        notifications: [
          {
            id: 2401,
            title,
            body,
            schedule: { at: new Date(Date.now() + 500) },
            smallIcon: 'ic_stat_tyag',
          },
        ],
      });
    } catch {
      /* notification support is optional */
    }
    return;
  }
  if (availability === 'web') {
    try {
      if (Notification.permission !== 'granted') return;
      new Notification(title, { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', silent: true });
    } catch {
      /* ignore */
    }
  }
}

/** Schedule a repeating local acknowledgement (native only, on-device). */
export async function scheduleNativeAcknowledgement(intervalMinutes: number): Promise<boolean> {
  if (Capacitor.isNativePlatform() !== true) return false;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const every = intervalMinutes >= 24 * 60 ? 'day' : intervalMinutes >= 60 ? 'hour' : 'minute';
    await LocalNotifications.schedule({
      notifications: [
        {
          id: 2402,
          title: 'Tyag',
          body: 'Your progress continues. Open Tyag to see where you are.',
          schedule: { at: new Date(Date.now() + intervalMinutes * 60_000), repeats: true, every },
          smallIcon: 'ic_stat_tyag',
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelNativeAcknowledgement(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: [{ id: 2402 }] });
  } catch {
    /* ignore */
  }
}
