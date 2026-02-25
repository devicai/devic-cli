// ── API Types (ported from devic-ui/src/api/types.ts) ──

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

export type RealtimeStatus = 'processing' | 'completed' | 'error' | 'waiting_for_tool_response' | 'handed_off';

export interface RealtimeChatHistory {
  chatUID: string;
  clientUID: string;
  chatHistory: ChatMessage[];
  status: RealtimeStatus;
  lastUpdatedAt: number;
  pendingToolCalls?: ToolCall[];
  handedOffSubThreadId?: string;
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
}

export interface AssistantSpecialization {
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

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
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
}

export interface AgentTaskDto {
  _id?: string;
  title?: string;
  description?: string;
  completed: boolean;
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
  lastEditTimestampMs?: number;
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

export interface CliConfig {
  apiKey?: string;
  baseUrl?: string;
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
} as const;
