interface LocalConversationSnapshot {
  events: import('./database-chat-state').StoredEvent[];
  older: string|null; details: Record<string,{after:string;snapshot:string}>; sequence:string; savedAt:string;
}
interface ConversationCacheStatus {tasks:number;bytes:number;lastSavedAt:string|null;audit?:{at:string;action:string;count:number}[]}
interface DesktopConversationCache {
  open: (token:string)=>Promise<string>;
  discard: (handle:string,task:string)=>Promise<void>;
  read: (handle:string,task:string)=>Promise<{snapshot:LocalConversationSnapshot|null;epoch:number}>;
  write: (handle:string,task:string,epoch:number,snapshot:LocalConversationSnapshot)=>Promise<void>;
  reconcile: (handle:string,token:string)=>Promise<string[]>;
  status: (handle:string)=>Promise<ConversationCacheStatus>;
  clear: (handle:string)=>Promise<void>;
  lock: ()=>Promise<void>;
}
interface ArtifactSyncStatus { directory: string; enabled: boolean; synced?: number; conflicts?: number; errors?: string[] }
interface Window {
  workpivotDesktop?: { loginServer?: (serverUrl: string, username: string, password: string) => Promise<{ok:boolean;error?:string}>; conversationCache?: DesktopConversationCache; changeServer?: () => Promise<void>; syncStatus?: (token: string) => Promise<ArtifactSyncStatus>; configureSync?: (token: string, enabled?: boolean) => Promise<ArtifactSyncStatus>; syncArtifacts?: (token: string) => Promise<ArtifactSyncStatus>; showSyncFolder?: (token: string) => Promise<void>; stopSync?: () => Promise<void>; selectDirectory: () => Promise<string | null>; artifactActionsVersion?: number; openArtifact?: (taskId: string, name: string, token: string, version?: string) => Promise<void>; showArtifact?: (taskId: string, name: string, token: string, version?: string) => Promise<void> };
}
