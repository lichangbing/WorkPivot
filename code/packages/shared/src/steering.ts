export type SteeringStatus = 'pending' | 'deferred' | 'applied' | 'cancelled';
export type SteeringRelation = 'unknown' | 'related' | 'unrelated';

/** 用户在运行中追加的要求，只在模型/工具安全边界进入上下文。 */
export interface SteeringMessage {
  id: string;
  taskId: string;
  runId: string;
  requestId: string;
  content: string;
  mode: 'safe';
  status: SteeringStatus;
  relation: SteeringRelation;
  classificationReason?: string;
  createdAt: string;
  appliedAt?: string;
  cancelledAt?: string;
  eventId?: string;
}
