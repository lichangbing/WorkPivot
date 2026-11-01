/** 用户与 Agent 之间可持久化、可恢复的四类交互。 */
export type InteractionKind = 'clarification' | 'plan_approval' | 'action_permission' | 'artifact_review';

export type InteractionState = 'pending' | 'answered' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type InteractionRisk = 'low' | 'medium' | 'high';

export interface InteractionOption {
  label: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  options: InteractionOption[];
  allowFreeText: boolean;
  multiSelect: boolean;
}

export interface ClarificationPayload {
  questions: ClarificationQuestion[];
}

export interface PlanStepView {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanDocument {
  id: string;
  revision: number;
  hash: string;
  status: 'draft' | 'approved' | 'superseded';
  goal: string;
  assumptions: string[];
  dataScope: string[];
  businessRules: string[];
  steps: PlanStepView[];
  externalActions: string[];
  outputs: string[];
  risks: string[];
  verification: string[];
  updatedAt: string;
}

export interface PlanApprovalPayload {
  plan: PlanDocument;
}

export interface ActionPermissionPayload {
  tool: string;
  command?: string;
  effects: string[];
  risk: InteractionRisk;
  summary: string;
  arguments?: Record<string, unknown>;
  feedbackAllowed: true;
}

export interface ArtifactReviewPayload {
  artifacts: Array<{ id: string; name: string; versionId?: string }>;
  machineVerified: boolean;
  verificationNotes: string[];
}

export type InteractionPayload =
  | ClarificationPayload
  | PlanApprovalPayload
  | ActionPermissionPayload
  | ArtifactReviewPayload;

export interface InteractionEnvelope {
  id: string;
  kind: InteractionKind;
  userId: string;
  taskId: string;
  runId: string;
  revision: number;
  state: InteractionState;
  blocking: boolean;
  risk: InteractionRisk;
  reason: string;
  payload: InteractionPayload;
  response?: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface ClarificationAnswer {
  questionId: string;
  value: string | string[];
}

export interface InteractionResponse {
  decision?: 'approve' | 'deny';
  answers?: ClarificationAnswer[];
  feedback?: string;
  /** 计划审批时用户修改后的版本；批准旧计划不能复用。 */
  plan?: PlanDocument;
}

export interface InteractionCapabilities {
  clarifyV2: boolean;
  planApproval: boolean;
  permissionPreview: boolean;
  artifactReview: boolean;
}

export function interactionCapabilities(env: NodeJS.ProcessEnv = process.env): InteractionCapabilities {
  const enabled = (key: string): boolean => env[key] !== '0' && env[key] !== 'off';
  return {
    clarifyV2: enabled('WORKPIVOT_INTERACTION_CLARIFY_V2'),
    planApproval: enabled('WORKPIVOT_INTERACTION_PLAN_APPROVAL'),
    permissionPreview: enabled('WORKPIVOT_INTERACTION_PERMISSION_PREVIEW'),
    artifactReview: enabled('WORKPIVOT_INTERACTION_ARTIFACT_REVIEW'),
  };
}
