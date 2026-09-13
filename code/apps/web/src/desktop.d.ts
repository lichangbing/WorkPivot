interface ArtifactSyncStatus { directory: string; enabled: boolean; synced?: number; conflicts?: number; errors?: string[] }
interface Window {
  workpivotDesktop?: { changeServer?: () => Promise<void>; syncStatus?: (token: string) => Promise<ArtifactSyncStatus>; configureSync?: (token: string, enabled?: boolean) => Promise<ArtifactSyncStatus>; syncArtifacts?: (token: string) => Promise<ArtifactSyncStatus>; showSyncFolder?: (token: string) => Promise<void>; stopSync?: () => Promise<void>; selectDirectory: () => Promise<string | null>; artifactActionsVersion?: number; openArtifact?: (taskId: string, name: string, token: string, version?: string) => Promise<void>; showArtifact?: (taskId: string, name: string, token: string, version?: string) => Promise<void> };
}
