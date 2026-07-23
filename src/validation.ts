import { DevicCliError } from './errors.js';

/**
 * Payload validator with intent-aware suggestions.
 *
 * Goal: when an agent (or a human) hands us a JSON with the wrong field names,
 * detect the mistake at the top level and reply with a readable error that
 * tells them exactly which field to use instead, instead of letting the API
 * silently drop the data or return a generic 400.
 */

export type EntityKind =
  | 'agent'
  | 'assistant'
  | 'tool-server'
  | 'tool-definition'
  | 'document'
  | 'project';

interface Alias {
  /** What the user probably meant, formatted for a CLI message. */
  suggestion: string;
}

interface Pattern {
  regex: RegExp;
  suggestion: string;
}

interface Schema {
  /** Display label for the entity in error messages. */
  label: string;
  /** Whitelist of accepted top-level keys for the payload. */
  allowed: string[];
  /** Exact wrong→suggestion mappings (matched case-insensitively). */
  aliases?: Record<string, Alias>;
  /** Fuzzy regex patterns tried after the alias lookup. */
  patterns?: Pattern[];
}

// ── Reusable suggestion strings ──────────────────────────────────────────────

const PROJECT_ID_HINT: Alias = {
  suggestion: 'Use `projectId` (string with the project _id).',
};

const PRESETS_NESTED_HINT: Alias = {
  suggestion:
    'For agents the system prompt goes nested: `{ "assistantSpecialization": { "presets": "..." } }`. There is no top-level `systemPrompt`/`prompt`/`instructions` field.',
};

const PRESETS_TOPLEVEL_HINT: Alias = {
  suggestion:
    'For assistants the system prompt field is `presets` (at the top level, not `systemPrompt`/`prompt`/`instructions`).',
};

const TOOL_GROUPS_NESTED_HINT: Alias = {
  suggestion:
    'Use `assistantSpecialization.availableToolsGroupsUids: ["<toolsGroupUid>"]`. Note: these are Tools **Group** UIDs, not Tool Server IDs. Assign the tool server to a Tools Group first from the dashboard.',
};

const TOOL_GROUPS_TOPLEVEL_HINT: Alias = {
  suggestion:
    'Use `availableToolsGroupsUids: ["<toolsGroupUid>"]`. These are Tools **Group** UIDs, not Tool Server IDs.',
};

// ── Schemas ──────────────────────────────────────────────────────────────────

const KNOWLEDGE_SKILLS_HINT = {
  suggestion:
    'Use `knowledgeSkills: [{ id, type: "document" | "folder" }]` (the `devic skills` catalog). Note `availableSkillIds` is a DIFFERENT, legacy feature (Tool Skills, mounted at runtime) — putting a catalog skill id there stores cleanly and does nothing.',
};

const AGENT_SCHEMA: Schema = {
  label: 'agent',
  allowed: [
    '_id',
    'name',
    'description',
    'imgUrl',
    'projectId',
    'assistantSpecialization',
    'provider',
    'llm',
    'maxExecutionInputTokens',
    'maxExecutionToolCalls',
    'maxExecutionFrequency',
    'executionFrequencyIntervalMs',
    'concurrentExecutionLimit',
    'agentNotificationConfig',
    'evaluationConfig',
    'subAgentConfig',
    'periodicExecution',
    'disabled',
    'archived',
  ],
  aliases: {
    project: PROJECT_ID_HINT,
    project_id: PROJECT_ID_HINT,
    projectid: PROJECT_ID_HINT,
    systemPrompt: PRESETS_NESTED_HINT,
    system_prompt: PRESETS_NESTED_HINT,
    systemMessage: PRESETS_NESTED_HINT,
    prompt: PRESETS_NESTED_HINT,
    prompts: PRESETS_NESTED_HINT,
    instructions: PRESETS_NESTED_HINT,
    presets: {
      suggestion:
        'For agents, wrap inside `assistantSpecialization`: `{ "assistantSpecialization": { "presets": "..." } }`.',
    },
    tools: TOOL_GROUPS_NESTED_HINT,
    toolServers: TOOL_GROUPS_NESTED_HINT,
    tool_servers: TOOL_GROUPS_NESTED_HINT,
    toolServerIds: TOOL_GROUPS_NESTED_HINT,
    toolServerId: TOOL_GROUPS_NESTED_HINT,
    toolsGroups: TOOL_GROUPS_NESTED_HINT,
    toolGroups: TOOL_GROUPS_NESTED_HINT,
    availableTools: TOOL_GROUPS_NESTED_HINT,
    availableToolsGroupsUids: {
      suggestion:
        'For agents this lives nested: `{ "assistantSpecialization": { "availableToolsGroupsUids": [...] } }`.',
    },
    enabledTools: {
      suggestion:
        'For agents this lives nested: `{ "assistantSpecialization": { "enabledTools": [...] } }`.',
    },
    model: {
      suggestion:
        'For agents the model goes either as top-level `llm` (string) or nested as `assistantSpecialization.model`.',
    },
    subagents: {
      suggestion:
        'Use `assistantSpecialization.subagentsIds: ["<agentId>"]`.',
    },
    subAgents: {
      suggestion:
        'Use `assistantSpecialization.subagentsIds: ["<agentId>"]`.',
    },
    subagentsIds: {
      suggestion:
        'For agents this lives nested: `{ "assistantSpecialization": { "subagentsIds": [...] } }`.',
    },
    knowledgeSkills: {
      suggestion:
        'For agents this lives nested: `{ "assistantSpecialization": { "knowledgeSkills": [{ id, type }] } }`.',
    },
    skills: KNOWLEDGE_SKILLS_HINT,
    skillIds: KNOWLEDGE_SKILLS_HINT,
    skillsIds: KNOWLEDGE_SKILLS_HINT,
    agentId: {
      suggestion:
        'Drop `agentId` — the ID is assigned by the API on creation, not provided in the payload.',
    },
  },
  patterns: [
    {
      regex: /^project/i,
      suggestion: 'Did you mean `projectId`?',
    },
    {
      regex: /prompt|instruction|preset/i,
      suggestion:
        'Did you mean `assistantSpecialization.presets`? (system prompt field, nested inside assistantSpecialization).',
    },
    {
      regex: /tool/i,
      suggestion:
        'Did you mean `assistantSpecialization.availableToolsGroupsUids`? (array of Tools **Group** UIDs, not Tool Server IDs).',
    },
    {
      regex: /subagent/i,
      suggestion: 'Did you mean `assistantSpecialization.subagentsIds`?',
    },
  ],
};

const ASSISTANT_SCHEMA: Schema = {
  label: 'assistant',
  allowed: [
    '_id',
    'name',
    'identifier',
    'description',
    'projectId',
    'presets',
    'model',
    'provider',
    'imgUrl',
    'state',
    'availableToolsGroupsUids',
    'enabledTools',
    'accessConfiguration',
    'widgetConfiguration',
    'memoryDocuments',
    'structuredOutput',
    'guardrailsConfiguration',
    'codeSnippetIds',
    'availableSkillIds',
    'knowledgeSkills',
    'subagentsIds',
    'maxChatMessages',
    'maxToolResponseInputTokens',
    'contextManagement',
    'isCustom',
  ],
  aliases: {
    project: PROJECT_ID_HINT,
    project_id: PROJECT_ID_HINT,
    projectid: PROJECT_ID_HINT,
    systemPrompt: PRESETS_TOPLEVEL_HINT,
    system_prompt: PRESETS_TOPLEVEL_HINT,
    systemMessage: PRESETS_TOPLEVEL_HINT,
    prompt: PRESETS_TOPLEVEL_HINT,
    prompts: PRESETS_TOPLEVEL_HINT,
    instructions: PRESETS_TOPLEVEL_HINT,
    assistantSpecialization: {
      suggestion:
        'Assistants do not wrap fields in `assistantSpecialization` — the assistant *is* the specialization. Move the inner fields (presets, availableToolsGroupsUids, model, etc.) to the top level.',
    },
    tools: TOOL_GROUPS_TOPLEVEL_HINT,
    toolServers: TOOL_GROUPS_TOPLEVEL_HINT,
    tool_servers: TOOL_GROUPS_TOPLEVEL_HINT,
    toolServerIds: TOOL_GROUPS_TOPLEVEL_HINT,
    toolServerId: TOOL_GROUPS_TOPLEVEL_HINT,
    toolsGroups: TOOL_GROUPS_TOPLEVEL_HINT,
    toolGroups: TOOL_GROUPS_TOPLEVEL_HINT,
    availableTools: TOOL_GROUPS_TOPLEVEL_HINT,
    subagents: {
      suggestion: 'Use `subagentsIds: ["<agentId>"]`.',
    },
    subAgents: {
      suggestion: 'Use `subagentsIds: ["<agentId>"]`.',
    },
    llm: {
      suggestion:
        'For assistants the model field is `model`, not `llm`.',
    },
    skills: KNOWLEDGE_SKILLS_HINT,
    skillIds: KNOWLEDGE_SKILLS_HINT,
    skillsIds: KNOWLEDGE_SKILLS_HINT,
    knowledge: {
      suggestion:
        'Attach documents and folders with `devic documents attach` / the folder attach endpoint — assistants do not take `knowledgeDocumentIds` in the payload. Skills do go in the payload, as `knowledgeSkills`.',
    },
  },
  patterns: [
    { regex: /^project/i, suggestion: 'Did you mean `projectId`?' },
    {
      regex: /prompt|instruction|preset/i,
      suggestion:
        'Did you mean `presets`? (top-level system prompt field for assistants).',
    },
    {
      regex: /tool/i,
      suggestion:
        'Did you mean `availableToolsGroupsUids`? (Tools **Group** UIDs, not Tool Server IDs).',
    },
    {
      regex: /subagent/i,
      suggestion: 'Did you mean `subagentsIds`?',
    },
  ],
};

const TOOL_SERVER_SCHEMA: Schema = {
  label: 'tool-server',
  allowed: [
    '_id',
    'name',
    'description',
    'url',
    'identifier',
    'enabled',
    'mcpType',
    'toolDefinitions',
    'authenticationConfig',
    'imageUrl',
  ],
  aliases: {
    tools: {
      suggestion:
        'Use `toolDefinitions` (array of tool definition objects with `type`, `function`, `endpoint`, `method`, ...).',
    },
    definitions: { suggestion: 'Use `toolDefinitions`.' },
    functions: { suggestion: 'Use `toolDefinitions` (each entry has `type: "function"` and a `function` object inside).' },
    auth: { suggestion: 'Use `authenticationConfig` (object with `type`, `token`/`apiKey`/`clientId`/...).' },
    authentication: { suggestion: 'Use `authenticationConfig`.' },
    authConfig: { suggestion: 'Use `authenticationConfig`.' },
    imgUrl: { suggestion: 'Use `imageUrl` (tool-server uses `imageUrl`, not `imgUrl`).' },
    image: { suggestion: 'Use `imageUrl`.' },
    baseUrl: { suggestion: 'Use `url` (base URL of the API).' },
    base_url: { suggestion: 'Use `url`.' },
    mcp: { suggestion: 'Use `mcpType: true` to flag this server as an MCP server.' },
    isMcp: { suggestion: 'Use `mcpType: true`.' },
    is_mcp: { suggestion: 'Use `mcpType: true`.' },
  },
  patterns: [
    { regex: /^auth/i, suggestion: 'Did you mean `authenticationConfig`?' },
    { regex: /(image|img|icon)/i, suggestion: 'Did you mean `imageUrl`?' },
    { regex: /^mcp/i, suggestion: 'Did you mean `mcpType` (boolean)?' },
    {
      regex: /(tool|definition|function)/i,
      suggestion: 'Did you mean `toolDefinitions`?',
    },
  ],
};

const TOOL_DEFINITION_SCHEMA: Schema = {
  label: 'tool-definition',
  allowed: [
    'type',
    'function',
    'endpoint',
    'method',
    'pathParametersKeys',
    'queryParametersKeys',
    'bodyPropertyKey',
    'bodyMode',
    'bodyJsonTemplate',
    'isFormDataBody',
    'customHeaders',
    'responsePostProcessingEnabled',
    'responsePostProcessingTemplate',
  ],
  aliases: {
    name: {
      suggestion:
        'The tool name lives inside `function.name`. Wrap as `{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} }, "endpoint": "..." }`.',
    },
    description: {
      suggestion:
        'The tool description lives inside `function.description`.',
    },
    parameters: {
      suggestion: 'The parameters schema lives inside `function.parameters`.',
    },
    url: { suggestion: 'Use `endpoint` (path relative to the tool server `url`).' },
    path: { suggestion: 'Use `endpoint`.' },
    httpMethod: { suggestion: 'Use `method` (GET|POST|PUT|DELETE|PATCH).' },
    verb: { suggestion: 'Use `method` (GET|POST|PUT|DELETE|PATCH).' },
    pathParams: { suggestion: 'Use `pathParametersKeys` (string[] of parameter names that appear in `endpoint` as `${name}`).' },
    queryParams: { suggestion: 'Use `queryParametersKeys` (string[]).' },
    body: {
      suggestion:
        'Use `bodyMode` (`simple` or `advanced`) with `bodyPropertyKey` (simple) or `bodyJsonTemplate` (advanced).',
    },
    headers: { suggestion: 'Use `customHeaders: [{headerName, value}]`.' },
    postProcessing: { suggestion: 'Use `responsePostProcessingEnabled` + `responsePostProcessingTemplate`.' },
    tool: {
      suggestion:
        'Drop the outer `tool` wrapper. The CLI sends the definition directly; just pass `{ "type": "function", "function": {...}, "endpoint": "...", "method": "..." }`.',
    },
  },
  patterns: [
    { regex: /^url$|^path$|^route$/i, suggestion: 'Did you mean `endpoint`?' },
    { regex: /method|verb/i, suggestion: 'Did you mean `method`?' },
    { regex: /header/i, suggestion: 'Did you mean `customHeaders`?' },
    { regex: /^body/i, suggestion: 'Did you mean `bodyMode` / `bodyPropertyKey` / `bodyJsonTemplate`?' },
    {
      regex: /(post.?process|transform|map.?response)/i,
      suggestion:
        'Did you mean `responsePostProcessingEnabled` + `responsePostProcessingTemplate`?',
    },
  ],
};

const DOCUMENT_SCHEMA: Schema = {
  label: 'document',
  allowed: [
    '_id',
    'name',
    'fileName',
    'fileType',
    'markdownContent',
    'summary',
    'projectId',
    'folderId',
    'parentDocumentId',
    'currentVersion',
    'tokenCount',
    'isSkill',
    'tags',
  ],
  aliases: {
    project: PROJECT_ID_HINT,
    project_id: PROJECT_ID_HINT,
    projectid: PROJECT_ID_HINT,
    folder: { suggestion: 'Use `folderId` (string with the folder _id).' },
    folder_id: { suggestion: 'Use `folderId`.' },
    parent: { suggestion: 'Use `parentDocumentId`.' },
    parentId: { suggestion: 'Use `parentDocumentId`.' },
    parent_document: { suggestion: 'Use `parentDocumentId`.' },
    content: { suggestion: 'Use `markdownContent` (the document body as markdown).' },
    body: { suggestion: 'Use `markdownContent`.' },
    text: { suggestion: 'Use `markdownContent`.' },
    markdown: { suggestion: 'Use `markdownContent`.' },
    md: { suggestion: 'Use `markdownContent`.' },
    title: { suggestion: 'Use `name`.' },
    file: { suggestion: 'Use `fileName` for the original filename, and `fileType` for the extension.' },
    type: { suggestion: 'Use `fileType` (md|pdf|txt|docx).' },
    extension: { suggestion: 'Use `fileType`.' },
    skill: { suggestion: 'Use `isSkill: true` to flag the document as a skill.' },
    is_skill: { suggestion: 'Use `isSkill`.' },
    categories: { suggestion: 'Use `tags` (array of strings).' },
    labels: { suggestion: 'Use `tags`.' },
  },
  patterns: [
    { regex: /^project/i, suggestion: 'Did you mean `projectId`?' },
    { regex: /^folder/i, suggestion: 'Did you mean `folderId`?' },
    { regex: /^parent/i, suggestion: 'Did you mean `parentDocumentId`?' },
    { regex: /(content|body|text|markdown)/i, suggestion: 'Did you mean `markdownContent`?' },
  ],
};

const PROJECT_SCHEMA: Schema = {
  label: 'project',
  allowed: [
    '_id',
    'name',
    'identifier',
    'description',
    'visibility',
    'archived',
    'imageUrl',
  ],
  aliases: {
    slug: { suggestion: 'Use `identifier` (URL-friendly slug, lowercase + hyphens).' },
    key: { suggestion: 'Use `identifier`.' },
    visibility_status: { suggestion: 'Use `visibility` (`public` | `private`).' },
    public: { suggestion: 'Use `visibility: "public"` instead of a boolean.' },
    private: { suggestion: 'Use `visibility: "private"` instead of a boolean.' },
    isPublic: { suggestion: 'Use `visibility` (`public` | `private`).' },
    archive: { suggestion: 'Use `archived` (boolean).' },
    isArchived: { suggestion: 'Use `archived`.' },
    imgUrl: { suggestion: 'Use `imageUrl` (project uses `imageUrl`, not `imgUrl`).' },
    image: { suggestion: 'Use `imageUrl`.' },
    icon: { suggestion: 'Use `imageUrl`.' },
  },
  patterns: [
    { regex: /(visibility|access|public|private)/i, suggestion: 'Did you mean `visibility` (`public` | `private`)?' },
    { regex: /(image|img|icon)/i, suggestion: 'Did you mean `imageUrl`?' },
    { regex: /(slug|key)/i, suggestion: 'Did you mean `identifier`?' },
  ],
};

const SCHEMAS: Record<EntityKind, Schema> = {
  agent: AGENT_SCHEMA,
  assistant: ASSISTANT_SCHEMA,
  'tool-server': TOOL_SERVER_SCHEMA,
  'tool-definition': TOOL_DEFINITION_SCHEMA,
  document: DOCUMENT_SCHEMA,
  project: PROJECT_SCHEMA,
};

// ── Value-type checks ────────────────────────────────────────────────────────

/**
 * Where the system prompt string lives for each entity that has one. The value
 * is canonically a plain string; a hand-built payload (often from an LLM
 * copilot) sometimes wraps it in an array of `{ name, content }` objects, which
 * the API stores verbatim and which then crashes the dashboard agent page
 * (`presets.split is not a function`). We catch that here, before the request.
 */
const PRESETS_PATH: Partial<Record<EntityKind, string>> = {
  agent: 'assistantSpecialization.presets',
  assistant: 'presets',
};

function getNested(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

/**
 * Type-checks known fields whose *value* shape matters (not just the key name).
 * Currently: the system prompt (`presets`) must be a plain string.
 */
export function inspectValueTypes(
  entity: EntityKind,
  payload: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const presetsPath = PRESETS_PATH[entity];
  if (presetsPath) {
    const value = getNested(payload, presetsPath);
    if (value !== undefined && value !== null && typeof value !== 'string') {
      const kind = Array.isArray(value) ? 'array' : typeof value;
      const actual = /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
      issues.push({
        key: presetsPath,
        suggestion:
          `The system prompt must be a plain string, but got ${actual}. ` +
          `Pass it as a single string, e.g. \`"${presetsPath}": "You are ..."\`. ` +
          `An array of \`{ name, content }\` objects is NOT a valid shape — it is ` +
          `stored verbatim and breaks the dashboard.`,
        confidence: 'high',
      });
    }
  }

  return issues;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ValidationIssue {
  key: string;
  suggestion: string;
  /** Confidence: `high` for explicit aliases, `medium` for regex hits, `low` for unknown. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Inspects the top-level keys of `payload` and returns a list of issues.
 * Does not throw. Use {@link assertValidPayload} to throw on issues.
 */
export function inspectPayload(
  entity: EntityKind,
  payload: Record<string, unknown>,
): ValidationIssue[] {
  const schema = SCHEMAS[entity];
  if (!schema) return [];

  const allowedLower = new Set(schema.allowed.map((k) => k.toLowerCase()));
  const aliasLowerMap = new Map<string, Alias>();
  for (const [key, alias] of Object.entries(schema.aliases ?? {})) {
    aliasLowerMap.set(key.toLowerCase(), alias);
  }

  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(payload)) {
    // Skip valid keys (case-insensitive — surface camelCase as the canonical form
    // via a separate alias entry if you want to flag e.g. `projectid` vs `projectId`).
    if (allowedLower.has(key.toLowerCase())) continue;

    const alias = aliasLowerMap.get(key.toLowerCase());
    if (alias) {
      issues.push({ key, suggestion: alias.suggestion, confidence: 'high' });
      continue;
    }

    const pattern = schema.patterns?.find((p) => p.regex.test(key));
    if (pattern) {
      issues.push({ key, suggestion: pattern.suggestion, confidence: 'medium' });
      continue;
    }

    issues.push({
      key,
      suggestion: `Unknown field. The API will silently ignore it. Valid fields: ${schema.allowed.join(', ')}.`,
      confidence: 'low',
    });
  }
  return issues;
}

/**
 * Throws DevicCliError with a formatted message if any issues are detected.
 * Pass `skip = true` to bypass validation entirely (for power users / forwards-compat).
 */
export function assertValidPayload(
  entity: EntityKind,
  payload: Record<string, unknown>,
  opts: { skip?: boolean } = {},
): void {
  if (opts.skip) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

  const issues = [
    ...inspectPayload(entity, payload),
    ...inspectValueTypes(entity, payload),
  ];
  if (issues.length === 0) return;

  const schema = SCHEMAS[entity];
  const lines: string[] = [];
  lines.push(
    `Invalid ${schema.label} payload — found ${issues.length} problem${issues.length === 1 ? '' : 's'}:`,
    '',
  );
  for (const issue of issues) {
    const marker = issue.confidence === 'high' ? '✖' : issue.confidence === 'medium' ? '?' : '·';
    lines.push(`  ${marker} \`${issue.key}\` → ${issue.suggestion}`);
  }
  lines.push('');
  lines.push(`Valid top-level fields for ${schema.label}:`);
  lines.push(`  ${schema.allowed.join(', ')}`);
  lines.push('');
  lines.push('To bypass this check (e.g. for fields newer than this CLI version), pass `--skip-validation`.');

  throw new DevicCliError(lines.join('\n'), 'INVALID_PAYLOAD');
}
