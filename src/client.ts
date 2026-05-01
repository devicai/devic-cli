import type {
  AssistantSpecialization,
  AsyncResponse,
  ProcessMessageDto,
  ChatMessage,
  RealtimeChatHistory,
  ChatHistory,
  ConversationSummary,
  ListConversationsResponse,
  ToolCallResponse,
  FeedbackSubmission,
  FeedbackEntry,
  AgentThreadDto,
  AgentDto,
  ToolServerDto,
  ToolDefinition,
  ApiError,
} from './types.js';
import { DevicApiError } from './errors.js';

const ENVELOPE_KEYS = new Set(['success', 'data', 'meta', 'error']);

function isGatewayEnvelope(value: unknown): value is { data: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!('data' in obj)) return false;
  for (const key of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(key)) return false;
  }
  return true;
}

export interface DevicApiClientConfig {
  apiKey: string;
  baseUrl: string;
  /** Optional async hook to obtain a new access token after a 401. */
  refreshToken?: () => Promise<string>;
  /** Optional hook that returns true when the token should be refreshed before sending. */
  shouldRefreshProactively?: () => boolean;
}

export class DevicApiClient {
  private config: DevicApiClientConfig;
  private refreshing?: Promise<string>;

  constructor(config: DevicApiClientConfig) {
    this.config = config;
  }

  private async refresh(): Promise<string> {
    if (!this.config.refreshToken) {
      throw new Error('No refresh handler configured');
    }
    if (!this.refreshing) {
      this.refreshing = this.config.refreshToken().finally(() => {
        this.refreshing = undefined;
      });
    }
    const next = await this.refreshing;
    this.config.apiKey = next;
    return next;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    isRetry = false,
  ): Promise<T> {
    if (
      !isRetry &&
      this.config.refreshToken &&
      this.config.shouldRefreshProactively?.()
    ) {
      try {
        await this.refresh();
      } catch {
        // Fall through; the request will likely 401 and we'll surface the original error.
      }
    }

    const url = `${this.config.baseUrl}${endpoint}`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      'devic-api-source': 'cli',
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      // Auto-refresh on 401 if we have a refresh hook, then retry once.
      if (response.status === 401 && this.config.refreshToken && !isRetry) {
        try {
          await this.refresh();
          return this.request<T>(endpoint, options, true);
        } catch (err) {
          // Refresh failed — fall through to surface the original 401.
        }
      }

      let errorData: ApiError;
      try {
        const body = await response.json();
        if (body && typeof body.error === 'object' && body.error !== null) {
          errorData = body.error as ApiError;
        } else {
          errorData = {
            statusCode: typeof body?.statusCode === 'number' ? body.statusCode : response.status,
            message: body?.message ?? response.statusText,
            error: typeof body?.error === 'string' ? body.error : undefined,
          };
        }
      } catch {
        errorData = { statusCode: response.status, message: response.statusText };
      }
      if (!errorData.statusCode) errorData.statusCode = response.status;
      throw new DevicApiError(errorData);
    }

    const data = await response.json();
    if (isGatewayEnvelope(data)) {
      return data.data as T;
    }
    return data as T;
  }

  // ── Assistants ──

  async getAssistants(external = false, projectId?: string): Promise<AssistantSpecialization[]> {
    const params = new URLSearchParams();
    if (external) params.set('external', 'true');
    if (projectId) params.set('projectId', projectId);
    const q = params.toString();
    return this.request<AssistantSpecialization[]>(`/api/v1/assistants${q ? `?${q}` : ''}`);
  }

  async getAssistant(identifier: string): Promise<AssistantSpecialization> {
    return this.request<AssistantSpecialization>(`/api/v1/assistants/${identifier}`);
  }

  async createAssistant(data: Record<string, unknown>): Promise<AssistantSpecialization> {
    return this.request(`/api/v1/assistants`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateAssistant(identifier: string, data: Record<string, unknown>): Promise<AssistantSpecialization> {
    return this.request(`/api/v1/assistants/${identifier}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteAssistant(identifier: string): Promise<unknown> {
    return this.request(`/api/v1/assistants/${identifier}`, { method: 'DELETE' });
  }

  async sendMessage(assistantId: string, dto: ProcessMessageDto, signal?: AbortSignal): Promise<ChatMessage[]> {
    const qs = dto.skipSummarization ? '?skipSummarization=true' : '';
    return this.request<ChatMessage[]>(`/api/v1/assistants/${assistantId}/messages${qs}`, {
      method: 'POST',
      body: JSON.stringify(dto),
      signal,
    });
  }

  async sendMessageAsync(assistantId: string, dto: ProcessMessageDto): Promise<AsyncResponse> {
    const qs = dto.skipSummarization ? '&skipSummarization=true' : '';
    return this.request<AsyncResponse>(`/api/v1/assistants/${assistantId}/messages?async=true${qs}`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  }

  async getRealtimeHistory(assistantId: string, chatUid: string): Promise<RealtimeChatHistory> {
    return this.request<RealtimeChatHistory>(`/api/v1/assistants/${assistantId}/chats/${chatUid}/realtime`);
  }

  async getChatHistory(assistantId: string, chatUid: string): Promise<ChatHistory> {
    return this.request<ChatHistory>(`/api/v1/assistants/${assistantId}/chats/${chatUid}`);
  }

  async listConversations(
    assistantId: string,
    opts?: { offset?: number; limit?: number; omitContent?: boolean },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.omitContent) params.set('omitContent', 'true');
    const q = params.toString();
    return this.request(`/api/v1/assistants/${assistantId}/chats${q ? `?${q}` : ''}`);
  }

  async searchChats(
    filters: Record<string, unknown>,
    opts?: { offset?: number; limit?: number; omitContent?: boolean },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.omitContent) params.set('omitContent', 'true');
    const q = params.toString();
    return this.request(`/api/v1/assistants/chats${q ? `?${q}` : ''}`, {
      method: 'POST',
      body: JSON.stringify(filters),
    });
  }

  async stopChat(assistantId: string, chatUid: string): Promise<{ chatUid: string; message: string }> {
    return this.request(`/api/v1/assistants/${assistantId}/chats/${chatUid}/stop`, { method: 'POST' });
  }

  async sendToolResponses(assistantId: string, chatUid: string, responses: ToolCallResponse[]): Promise<AsyncResponse> {
    return this.request(`/api/v1/assistants/${assistantId}/chats/${chatUid}/tool-response`, {
      method: 'POST',
      body: JSON.stringify({ responses }),
    });
  }

  // ── Chat Feedback ──

  async submitChatFeedback(assistantId: string, chatUid: string, data: FeedbackSubmission): Promise<FeedbackEntry> {
    return this.request(`/api/v1/assistants/${assistantId}/chats/${chatUid}/feedback`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getChatFeedback(assistantId: string, chatUid: string): Promise<FeedbackEntry[]> {
    return this.request(`/api/v1/assistants/${assistantId}/chats/${chatUid}/feedback`);
  }

  // ── Agents ──

  async listAgents(opts?: {
    offset?: number;
    limit?: number;
    archived?: boolean;
    projectId?: string;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.archived != null) params.set('archived', String(opts.archived));
    if (opts?.projectId) params.set('projectId', opts.projectId);
    const q = params.toString();
    return this.request(`/api/v1/agents${q ? `?${q}` : ''}`);
  }

  async getAgent(agentId: string): Promise<AgentDto> {
    return this.request(`/api/v1/agents/${agentId}`);
  }

  async createAgent(data: Record<string, unknown>): Promise<AgentDto> {
    return this.request(`/api/v1/agents`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateAgent(agentId: string, data: Record<string, unknown>): Promise<AgentDto> {
    return this.request(`/api/v1/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteAgent(agentId: string): Promise<unknown> {
    return this.request(`/api/v1/agents/${agentId}`, { method: 'DELETE' });
  }

  // ── Threads ──

  async createThread(agentId: string, data: { message: string; tags?: string[]; metadata?: Record<string, unknown> }): Promise<unknown> {
    return this.request(`/api/v1/agents/${agentId}/threads`, { method: 'POST', body: JSON.stringify(data) });
  }

  async listThreads(
    agentId: string,
    opts?: { offset?: number; limit?: number; state?: string; startDate?: string; endDate?: string; dateOrder?: string; tags?: string; omitContent?: boolean },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.state) params.set('state', opts.state);
    if (opts?.startDate) params.set('startDate', opts.startDate);
    if (opts?.endDate) params.set('endDate', opts.endDate);
    if (opts?.dateOrder) params.set('dateOrder', opts.dateOrder);
    if (opts?.tags) params.set('tags', opts.tags);
    if (opts?.omitContent) params.set('omitContent', 'true');
    const q = params.toString();
    return this.request(`/api/v1/agents/${agentId}/threads${q ? `?${q}` : ''}`);
  }

  async getThread(threadId: string, withTasks = false): Promise<AgentThreadDto> {
    const q = withTasks ? '?withTasks=true' : '';
    return this.request(`/api/v1/agents/threads/${threadId}${q}`);
  }

  async updateThread(threadId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async handleApproval(threadId: string, approved: boolean, message?: string): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approved, message }),
    });
  }

  async completeThread(threadId: string, state: string): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ state }),
    });
  }

  async pauseThread(threadId: string): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}/pause`, { method: 'POST' });
  }

  async resumeThread(threadId: string): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}/resume`, { method: 'POST' });
  }

  async evaluateThread(threadId: string): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}/evaluate`, { method: 'POST' });
  }

  async getThreadEvaluation(threadId: string): Promise<unknown> {
    return this.request(`/api/v1/agents/threads/${threadId}/evaluation`);
  }

  // ── Thread Feedback ──

  async submitThreadFeedback(threadId: string, data: FeedbackSubmission): Promise<FeedbackEntry> {
    return this.request(`/api/v1/agents/threads/${threadId}/feedback`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getThreadFeedback(threadId: string): Promise<FeedbackEntry[]> {
    return this.request(`/api/v1/agents/threads/${threadId}/feedback`);
  }

  // ── Costs ──

  async getDailyCosts(agentId: string, opts?: { startDate?: string; endDate?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.startDate) params.set('startDate', opts.startDate);
    if (opts?.endDate) params.set('endDate', opts.endDate);
    const q = params.toString();
    return this.request(`/api/v1/agents/agents/${agentId}/costs/daily${q ? `?${q}` : ''}`);
  }

  async getMonthlyCosts(agentId: string, opts?: { startMonth?: string; endMonth?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.startMonth) params.set('startMonth', opts.startMonth);
    if (opts?.endMonth) params.set('endMonth', opts.endMonth);
    const q = params.toString();
    return this.request(`/api/v1/agents/agents/${agentId}/costs/monthly${q ? `?${q}` : ''}`);
  }

  async getCostSummary(agentId: string): Promise<unknown> {
    return this.request(`/api/v1/agents/agents/${agentId}/costs/summary`);
  }

  // ── Tool Servers ──

  async listToolServers(opts?: { offset?: number; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const q = params.toString();
    return this.request(`/api/v1/tool-servers${q ? `?${q}` : ''}`);
  }

  async getToolServer(toolServerId: string): Promise<ToolServerDto> {
    return this.request(`/api/v1/tool-servers/${toolServerId}`);
  }

  async createToolServer(data: Record<string, unknown>): Promise<ToolServerDto> {
    return this.request(`/api/v1/tool-servers`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateToolServer(toolServerId: string, data: Record<string, unknown>): Promise<ToolServerDto> {
    return this.request(`/api/v1/tool-servers/${toolServerId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteToolServer(toolServerId: string): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}`, { method: 'DELETE' });
  }

  async cloneToolServer(toolServerId: string): Promise<ToolServerDto> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/clone`, { method: 'POST' });
  }

  // ── Tool Server Definition ──

  async getToolServerDefinition(toolServerId: string): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/definition`);
  }

  async updateToolServerDefinition(toolServerId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/definition`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // ── Tools ──

  async listTools(toolServerId: string): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/tools`);
  }

  async getTool(toolServerId: string, toolName: string): Promise<ToolDefinition> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/tools/${toolName}`);
  }

  async addTool(toolServerId: string, tool: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/tools`, {
      method: 'POST',
      body: JSON.stringify({ tool }),
    });
  }

  async updateTool(toolServerId: string, toolName: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/tools/${toolName}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteTool(toolServerId: string, toolName: string): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/tools/${toolName}`, { method: 'DELETE' });
  }

  async testTool(toolServerId: string, toolName: string, parameters: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/tool-servers/${toolServerId}/tools/${toolName}/test`, {
      method: 'POST',
      body: JSON.stringify({ parameters }),
    });
  }

  // ── Projects ──

  async listProjects(opts?: { archived?: boolean }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.archived != null) params.set('archived', String(opts.archived));
    const q = params.toString();
    return this.request(`/api/v1/projects${q ? `?${q}` : ''}`);
  }

  async getProject(projectId: string): Promise<unknown> {
    return this.request(`/api/v1/projects/${projectId}`);
  }

  async createProject(data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/projects`, { method: 'POST', body: JSON.stringify(data) });
  }

  async updateProject(projectId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async archiveProject(projectId: string): Promise<unknown> {
    return this.request(`/api/v1/projects/${projectId}`, { method: 'DELETE' });
  }

  async getProjectThreads(
    projectId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const q = params.toString();
    return this.request(`/api/v1/projects/${projectId}/threads${q ? `?${q}` : ''}`);
  }

  async getProjectConversations(
    projectId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const q = params.toString();
    return this.request(`/api/v1/projects/${projectId}/conversations${q ? `?${q}` : ''}`);
  }

  async getProjectStats(projectId: string): Promise<unknown> {
    return this.request(`/api/v1/projects/${projectId}/stats`);
  }

  async getProjectDailyCosts(
    projectId: string,
    opts?: { startDate?: string; endDate?: string; tenantId?: string },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.startDate) params.set('startDate', opts.startDate);
    if (opts?.endDate) params.set('endDate', opts.endDate);
    if (opts?.tenantId) params.set('tenantId', opts.tenantId);
    const q = params.toString();
    return this.request(`/api/v1/projects/${projectId}/costs/daily${q ? `?${q}` : ''}`);
  }

  async getProjectMonthlyCosts(
    projectId: string,
    opts?: { startMonth?: string; endMonth?: string; tenantId?: string },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.startMonth) params.set('startMonth', opts.startMonth);
    if (opts?.endMonth) params.set('endMonth', opts.endMonth);
    if (opts?.tenantId) params.set('tenantId', opts.tenantId);
    const q = params.toString();
    return this.request(`/api/v1/projects/${projectId}/costs/monthly${q ? `?${q}` : ''}`);
  }

  // ── Documents ──

  async listDocuments(opts?: {
    projectId?: string;
    status?: string;
    fileType?: string;
    search?: string;
    folderId?: string;
    parentOnly?: boolean;
    offset?: number;
    limit?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set('projectId', opts.projectId);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.fileType) params.set('fileType', opts.fileType);
    if (opts?.search) params.set('search', opts.search);
    if (opts?.folderId) params.set('folderId', opts.folderId);
    if (opts?.parentOnly) params.set('parentOnly', 'true');
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const q = params.toString();
    return this.request(`/api/v1/documents${q ? `?${q}` : ''}`);
  }

  async getDocument(documentId: string): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}`);
  }

  async createMarkdownDocument(data: {
    name: string;
    markdownContent: string;
    projectId?: string;
    parentDocumentId?: string;
  }): Promise<unknown> {
    return this.request(`/api/v1/documents`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateDocument(documentId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteDocument(documentId: string): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}`, { method: 'DELETE' });
  }

  async listDocumentVersions(documentId: string): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/versions`);
  }

  async getDocumentVersion(documentId: string, version: number): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/versions/${version}`);
  }

  async revertDocument(documentId: string, version: number): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/revert/${version}`, {
      method: 'POST',
    });
  }

  async getDocumentSubdocuments(documentId: string): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/subdocuments`);
  }

  async getDocumentUsage(documentId: string): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/usage`);
  }

  async attachDocument(
    documentId: string,
    targetType: 'agent' | 'assistant',
    targetId: string,
  ): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/attach`, {
      method: 'POST',
      body: JSON.stringify({ targetType, targetId }),
    });
  }

  async detachDocument(
    documentId: string,
    targetType: 'agent' | 'assistant',
    targetId: string,
  ): Promise<unknown> {
    return this.request(`/api/v1/documents/${documentId}/detach`, {
      method: 'POST',
      body: JSON.stringify({ targetType, targetId }),
    });
  }

  // ── Document Folders ──

  async listDocumentFolders(opts?: { projectId?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set('projectId', opts.projectId);
    const q = params.toString();
    return this.request(`/api/v1/document-folders${q ? `?${q}` : ''}`);
  }

  async createDocumentFolder(data: {
    name: string;
    projectId?: string;
    parentFolderId?: string;
    color?: string;
  }): Promise<unknown> {
    return this.request(`/api/v1/document-folders`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateDocumentFolder(folderId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/v1/document-folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteDocumentFolder(folderId: string, deleteDocuments = false): Promise<unknown> {
    const q = deleteDocuments ? '?deleteDocuments=true' : '';
    return this.request(`/api/v1/document-folders/${folderId}${q}`, {
      method: 'DELETE',
    });
  }
}
