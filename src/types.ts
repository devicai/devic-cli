// ── API Types (ported from devic-ui/src/api/types.ts) ──

export interface SkillCatalogItem {
  id: string;
  type: 'document' | 'folder';
  name: string;
  description: string;
  tags: string[];
  projectId?: string;
  readCount?: number;
  lastReadAt?: string;
  linkedAgentsCount?: number;
  linkedAssistantsCount?: number;
}

export interface SkillCatalogPage {
  items: SkillCatalogItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SkillTreeFile {
  path: string;
  content: string;
  fileType?: string;
}

export interface SkillTree {
  skill: SkillCatalogItem;
  files: SkillTreeFile[];
  version: string;
}

export interface ChatFile {
  name: string;
  downloadUrl?: string;
  fileType?: 'image' | 'document' | 'audio' | 'video' | 'other';
}

export interface MessageContent {
  message?: string;
  data?: unknown;
  files?: Array<{ name: string; url: string; type: string }>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  uid: string;
  role: 'user' | 'assistant' | 'developer' | 'tool';
  content: MessageContent;
  timestamp: number;
  chatUid?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  summary?: string;
}

export interface PreviousMessage {
  message: string;
  role: 'user' | 'assistant';
}

export interface ToolCallResponse {
  tool_call_id: string;
  content: unknown;
  role: 'tool';
}

export interface ProcessMessageDto {
  message: string;
  chatUid?: string;
  userName?: string;
  files?: ChatFile[];
  metadata?: Record<string, unknown>;
  tenantId?: string;
  previousConversation?: PreviousMessage[];
  enabledTools?: string[];
  provider?: string;
  model?: string;
  tags?: string[];
  skipSummarization?: boolean;
}

export interface AsyncResponse {
  chatUid: string;
  message?: string;
  error?: string;
}

export type RealtimeStatus =
  | 'buffering'
  | 'processing'
  | 'completed'
  | 'error'
  | 'waiting_for_tool_response'
  | 'handed_off'
  | 'limit_exceeded';

export interface RealtimeChatHistory {
  chatUID: string;
  clientUID: string;
  chatHistory: ChatMessage[];
  status: RealtimeStatus;
  lastUpdatedAt: number;
  pendingToolCalls?: ToolCall[];
  handedOffSubThreadId?: string;
  /** Present when `status === 'limit_exceeded'`: what blocked the message. */
  limitExceeded?: {
    message?: string;
    blockingRule?: unknown;
    current?: number;
    limit?: number;
    resetsAt?: number;
  };
}

export interface ChatHistory {
  chatUID: string;
  clientUID: string;
  userUID: string;
  chatContent: ChatMessage[];
  name?: string;
  assistantSpecializationIdentifier: string;
  creationTimestampMs: number;
  lastEditTimestampMs?: number;
  llm?: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
  tenantId?: string;
  handedOff?: boolean;
  handedOffSubThreadId?: string;
  handedOffToolCallId?: string;
  tokenUsage?: ThreadTokenUsage;
}

export interface AssistantSpecialization {
  _id?: string;
  identifier: string;
  name: string;
  description: string;
  state?: 'active' | 'inactive' | 'coming_soon';
  imgUrl?: string;
  availableToolsGroups?: Array<{
    name: string;
    description?: string;
    uid?: string;
    iconUrl?: string;
    tools?: Array<{ name: string; description: string }>;
  }>;
  availableToolsGroupsUids?: string[];
  /** Allowlist of tool names; null means every tool of the assigned groups. */
  enabledTools?: string[] | null;
  model?: string;
  provider?: string;
  isCustom?: boolean;
  creationTimestampMs?: number;
}

export interface ConversationSummary {
  chatUID: string;
  name?: string;
  creationTimestampMs: number;
  lastEditTimestampMs?: number;
}

export interface ListConversationsResponse {
  histories: ConversationSummary[];
  total: number;
  offset: number;
  limit: number;
}

/** A subagent reference rejected by the backend, with the reason why. */
export interface InvalidSubagentRef {
  id: string;
  name?: string;
  reason: 'NOT_FOUND' | 'NOT_ENABLED' | 'ARCHIVED';
}

export interface ApiError {
  statusCode: number;
  message: string;
  /** String error code (e.g. `INVALID_SUBAGENTS`, `BAD_REQUEST`). */
  error?: string;
  /** Dotted path of the offending field, when the backend provides it. */
  field?: string;
  /** Populated for `INVALID_SUBAGENTS`: the subagents that failed validation. */
  invalidSubagents?: InvalidSubagentRef[];
}

export interface FeedbackSubmission {
  messageId: string;
  feedback?: boolean;
  feedbackComment?: string;
  feedbackData?: Record<string, unknown>;
}

export interface FeedbackEntry {
  _id: string;
  requestId: string;
  chatUID?: string;
  threadId?: string;
  agentId?: string;
  feedback?: boolean;
  feedbackComment?: string;
  feedbackData?: Record<string, unknown>;
  creationTimestamp: string;
  lastEditTimestamp?: string;
}

export enum AgentThreadState {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TERMINATED = 'terminated',
  PAUSED = 'paused',
  PAUSED_FOR_APPROVAL = 'paused_for_approval',
  APPROVAL_REJECTED = 'approval_rejected',
  WAITING_FOR_RESPONSE = 'waiting_for_response',
  PAUSED_FOR_RESUME = 'paused_for_resume',
  HANDED_OFF = 'handed_off',
  GUARDRAIL_TRIGGER = 'guardrail_trigger',
  UNDER_CONSTRUCTION = 'under_construction',
  LIMIT_EXCEEDED = 'limit_exceeded',
}

export interface AgentTaskDto {
  _id?: string;
  title?: string;
  description?: string;
  completed: boolean;
}

export interface ThreadStateChange {
  state: AgentThreadState;
  timestamp: number;
  userUID?: string;
  source?: string;
}

export interface ThreadTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: { totalCost?: number };
}

export interface AgentThreadDto {
  _id?: string;
  agentId: string;
  state: AgentThreadState;
  threadContent: ChatMessage[];
  tasks?: AgentTaskDto[];
  finishReason?: string;
  pausedReason?: string;
  name?: string;
  creationTimestampMs?: number;
  finishTimestampMs?: number;
  lastEditTimestampMs?: number;
  threadStatesChanges?: ThreadStateChange[];
  tokenUsage?: ThreadTokenUsage;
  /** Epoch ms when a `paused` thread is scheduled to resume. Only present on newer API versions. */
  pausedUntil?: number;
  pausedTimestampMS?: number;
  pauseUntil?: number;
  isSubthread?: boolean;
  parentThreadId?: string;
  subThreadToolCallId?: string;
  parentAgentId?: string;
  pendingHandOffSubThreadIds?: string[];
  handOffSubThreadIds?: string[];
}

export interface AgentDto {
  _id?: string;
  name: string;
  description?: string;
  imgUrl?: string;
  agentId?: string;
  disabled?: boolean;
  archived?: boolean;
  provider?: string;
  llm?: string;
  assistantSpecialization?: Record<string, unknown>;
  maxExecutionInputTokens?: number;
  maxExecutionToolCalls?: number;
  evaluationConfig?: Record<string, unknown>;
  subAgentConfig?: Record<string, unknown>;
  creationTimestampMs?: number;
}

export interface ToolServerDto {
  _id?: string;
  name: string;
  description?: string;
  url?: string;
  identifier?: string;
  enabled?: boolean;
  toolServerDefinitionId?: string;
  toolServerDefinition?: { toolDefinitions: ToolDefinition[] };
  authenticationConfig?: Record<string, unknown>;
  mcpType?: boolean;
  imageUrl?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  endpoint?: string;
  method?: string;
  pathParametersKeys?: string[];
  queryParametersKeys?: string[];
  bodyPropertyKey?: string;
  bodyMode?: 'simple' | 'advanced';
  bodyJsonTemplate?: string;
  isFormDataBody?: boolean;
  customHeaders?: Array<{ headerName: string; value: string }>;
  responsePostProcessingEnabled?: boolean;
  responsePostProcessingTemplate?: string;
}

// ── CLI-specific types ──

export type OutputFormat = 'json' | 'human';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch ms when the access token expires */
  expiresAt: number;
  scope?: string;
  clientId: string;
}

export interface CliConfig {
  /** Long-lived API key (legacy `devic-XXX` flow) */
  apiKey?: string;
  baseUrl?: string;
  /** OAuth tokens (preferred when present) */
  oauth?: OAuthTokens;
}

export interface PollOptions {
  initialIntervalMs: number;
  backoffMultiplier: number;
  maxIntervalMs: number;
  timeoutMs: number;
}

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  AUTH_REQUIRED: 2,
  POLL_TIMEOUT: 3,
  /** `watch`: execution stopped waiting for a human decision. */
  WATCH_APPROVAL_REQUIRED: 10,
  /** `watch`: execution is waiting on something outside the CLI (external channel, scheduled resume). */
  WATCH_WAITING: 11,
  /** `watch`: still running — call again with the returned cursor. */
  WATCH_ALIVE: 12,
  /** `watch`: no progress for several consecutive checks. */
  WATCH_STALLED: 13,
} as const;
