import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  API_PROTOCOL,
  parseClientUpdateEnvelope,
  selectClientUpdate,
  type ClientUpdateManifest,
} from '@workpivot/shared';
import type { MobileClient } from './client';

interface NativeUpdater {
  getInfo(): Promise<{ packageName: string; versionName: string; versionCode: number; signerSha256: string }>;
  downloadAndInstall(options: {
    url: string;
    sha256: string;
    packageName: string;
    signerSha256: string;
    build: number;
  }): Promise<{ status: 'permission-required' | 'installer-opened' }>;
}

const nativeUpdater = registerPlugin<NativeUpdater>('WorkPivotUpdater');
const intervalMs = 6 * 60 * 60 * 1000;

export interface AvailableUpdate { manifest: ClientUpdateManifest; currentVersion: string; currentBuild: number }

export async function checkAndroidUpdate(client: MobileClient, signal: AbortSignal): Promise<AvailableUpdate | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  const [info, raw] = await Promise.all([
    nativeUpdater.getInfo(),
    client.json<unknown>('/api/client-updates', { signal }),
  ]);
  const envelope = parseClientUpdateEnvelope(raw);
  const manifest = selectClientUpdate(envelope, {
    platform: 'android',
    channel: 'beta',
    build: info.versionCode,
    apiProtocol: API_PROTOCOL,
  });
  return manifest ? { manifest, currentVersion: info.versionName, currentBuild: info.versionCode } : null;
}

export async function installAndroidUpdate(manifest: ClientUpdateManifest): Promise<'permission-required' | 'installer-opened'> {
  const result = await nativeUpdater.downloadAndInstall({
    url: manifest.downloadUrl,
    sha256: manifest.sha256,
    packageName: manifest.packageName!,
    signerSha256: manifest.signerSha256!,
    build: manifest.build,
  });
  return result.status;
}

export function updateCheckDelay(random = Math.random): number {
  return intervalMs + Math.floor(random() * 4 * 60 * 60 * 1000);
}

export function updateDismissKey(manifest: ClientUpdateManifest): string {
  return `wp-mobile-update-dismissed:${manifest.channel}:${manifest.build}`;
}
