import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  createClient,
  withAction,
  addListOptions,
  parseListOpts,
  readAndValidateJson,
  addSkipValidationOption,
  resolveProjectId,
  readTextStdin,
  isStdinPiped,
} from '../helpers.js';
import { md } from '../output.js';

interface DocumentDto {
  _id?: string;
  name?: string;
  fileName?: string;
  fileType?: string;
  status?: string;
  size?: number;
  projectId?: string;
  folderId?: string;
  parentDocumentId?: string;
  currentVersion?: number;
  tokenCount?: number;
  markdownContent?: string;
  summary?: string;
  creationTimestampMs?: number;
  lastEditTimestampMs?: number;
  /** Transient flag set by the API on update: whether a new version was created. */
  versionCreated?: boolean;
}

function formatDocument(d: DocumentDto): string {
  const lines = [
    md.h(2, `Document: ${d.name ?? '-'}`),
    '',
    `**ID:** ${md.code(d._id ?? '-')}`,
    `**File:** ${d.fileName ?? '-'} (${d.fileType ?? '-'})`,
    `**Status:** ${md.status(d.status ?? '-')} ${d.status ?? '-'}`,
  ];
  if (d.projectId) lines.push(`**Project:** ${md.code(d.projectId)}`);
  if (d.folderId) lines.push(`**Folder:** ${md.code(d.folderId)}`);
  if (d.parentDocumentId)
    lines.push(`**Parent:** ${md.code(d.parentDocumentId)}`);
  if (d.size != null) lines.push(`**Size:** ${d.size} bytes`);
  if (d.tokenCount != null) lines.push(`**Tokens:** ${d.tokenCount}`);
  if (d.currentVersion != null)
    lines.push(`**Version:** ${d.currentVersion}`);
  if (d.creationTimestampMs)
    lines.push(`**Created:** ${new Date(d.creationTimestampMs).toLocaleString()}`);
  if (d.lastEditTimestampMs)
    lines.push(`**Updated:** ${new Date(d.lastEditTimestampMs).toLocaleString()}`);
  if (d.summary) {
    lines.push('', md.h(3, 'Summary'), d.summary);
  }
  if (d.markdownContent) {
    lines.push('', md.h(3, 'Content'), md.codeBlock(d.markdownContent, 'markdown'));
  }
  return lines.join('\n');
}

export function registerDocumentCommands(program: Command): void {
  const documents = program
    .command('documents')
    .description('Manage knowledge documents');

  // documents list
  addListOptions(
    documents
      .command('list')
      .description('List documents')
      .option('--project <project>', 'Filter by project (_id, identifier, or name)')
      .option('--status <status>', 'Filter by status (pending|ready|failed)')
      .option('--file-type <type>', 'Filter by file type (md|pdf|txt|docx)')
      .option('--search <text>', 'Free-text search')
      .option('--folder <folderId>', 'Filter by folder ID (use "none" for unfiled)')
      .option('--parent-only', 'Only return root documents (no parents)'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as {
        offset?: string;
        limit?: string;
        project?: string;
        status?: string;
        fileType?: string;
        search?: string;
        folder?: string;
        parentOnly?: boolean;
      };
      const client = createClient();
      const result = (await client.listDocuments({
        ...parseListOpts(o),
        projectId: o.project ? await resolveProjectId(client, o.project) : undefined,
        status: o.status,
        fileType: o.fileType,
        search: o.search,
        folderId: o.folder,
        parentOnly: o.parentOnly,
      })) as any;
      const stripContent = (doc: any) => {
        if (!doc || typeof doc !== 'object') return doc;
        const { markdownContent, ...rest } = doc;
        return rest;
      };
      if (Array.isArray(result)) return result.map(stripContent);
      if (result?.documents && Array.isArray(result.documents)) {
        return { ...result, documents: result.documents.map(stripContent) };
      }
      return result;
    }, (d) => {
      const data = d as any;
      const items = data.documents ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No documents found._';
      return [
        md.h(2, 'Documents'),
        '',
        md.table(
          items.map((doc: any) => ({
            id: doc._id,
            name: doc.name,
            type: doc.fileType,
            status: doc.status,
            project: doc.projectId || '-',
            updated: doc.lastEditTimestampMs
              ? new Date(doc.lastEditTimestampMs).toLocaleString()
              : '-',
          })),
          { columns: ['id', 'name', 'type', 'status', 'project', 'updated'] },
        ),
        ...(data.total != null ? [md.pagination(data)] : []),
      ].join('\n');
    }),
  );

  // documents get <id>
  documents
    .command('get <documentId>')
    .description('Get document details')
    .action(
      withAction(async (documentId: unknown) => {
        const client = createClient();
        return client.getDocument(documentId as string);
      }, (d) => formatDocument(d as DocumentDto)),
    );

  // documents create
  addSkipValidationOption(
    documents
      .command('create')
      .description('Create a markdown document')
      .option('--name <name>', 'Document name')
      .option('--content <text>', 'Inline markdown content')
      .option('--from-file <path>', 'Read markdown content from file')
      .option('--from-stdin', 'Read markdown content from stdin (also auto-detected when piped)')
      .option('--project <project>', 'Optional project (_id, identifier, or name)')
      .option('--parent <documentId>', 'Optional parent document ID')
      .option('--folder <folderId>', 'File the document into a folder')
      .option('--tags <tags...>', 'Category tags')
      .option('--as-skill', 'Flag the document as a skill (name/description come from its frontmatter)')
      .option('--from-json <file>', 'Read full payload from JSON file (- for stdin)'),
  ).action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          name?: string;
          content?: string;
          fromFile?: string;
          fromStdin?: boolean;
          project?: string;
          parent?: string;
          folder?: string;
          tags?: string[];
          asSkill?: boolean;
          fromJson?: string;
          skipValidation?: boolean;
        };
        const client = createClient();

        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'document', { skip: o.skipValidation });
        } else {
          if (!o.name) throw new Error('--name is required (or use --from-json)');
          let content = o.content;
          if (content == null && o.fromFile) {
            content = readFileSync(o.fromFile, 'utf-8');
          }
          if (content == null && (o.fromStdin || isStdinPiped())) {
            const piped = await readTextStdin();
            if (piped.length > 0) content = piped;
          }
          if (content == null) {
            throw new Error(
              'Provide document content via --content, --from-file <path>, or `--from-stdin` (e.g. `cat file.md | devic documents create --name X --from-stdin`).',
            );
          }
          data = { name: o.name, markdownContent: content };
          if (o.project) data.projectId = await resolveProjectId(client, o.project);
          if (o.parent) data.parentDocumentId = o.parent;
          if (o.folder) data.folderId = o.folder;
          if (o.tags?.length) data.tags = o.tags;
          if (o.asSkill) data.isSkill = true;
        }

        return client.createMarkdownDocument(data as any);
      }, (d) => {
        const doc = d as DocumentDto;
        return [
          md.success(`Document created: ${md.b(doc.name ?? '-')}`),
          '',
          formatDocument(doc),
        ].join('\n');
      }),
    );

  // documents update <id>
  addSkipValidationOption(
    documents
      .command('update <documentId>')
      .description('Update a document (creates a new version when content changes)')
      .option('--name <name>', 'Document name')
      .option('--summary <text>', 'Document summary')
      .option('--content <text>', 'Inline markdown content')
      .option('--from-file <path>', 'Read markdown content from file')
      .option('--from-stdin', 'Read markdown content from stdin (also auto-detected when piped)')
      .option('--project <project>', 'Project _id, identifier, or name (use "null" to unset)')
      .option('--folder <folderId>', 'Folder ID (use "null" to unset)')
      .option('--tags <tags...>', 'Category tags (replaces the current list)')
      .option('--as-skill', 'Flag the document as a skill')
      .option('--no-skill', 'Unflag the document as a skill')
      .option('--from-json <file>', 'Read full payload from JSON file (- for stdin)'),
  ).action(
      withAction(async (documentId: unknown, opts: unknown) => {
        const id = documentId as string;
        const o = opts as {
          name?: string;
          summary?: string;
          content?: string;
          fromFile?: string;
          fromStdin?: boolean;
          project?: string;
          folder?: string;
          tags?: string[];
          asSkill?: boolean;
          // commander maps `--no-skill` to `skill: false`; absent means untouched.
          skill?: boolean;
          fromJson?: string;
          skipValidation?: boolean;
        };
        const client = createClient();

        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'document', { skip: o.skipValidation });
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.summary) data.summary = o.summary;
          if (o.tags?.length) data.tags = o.tags;
          if (o.asSkill) data.isSkill = true;
          else if (o.skill === false) data.isSkill = false;
          if (o.project !== undefined)
            data.projectId = o.project === 'null' ? null : await resolveProjectId(client, o.project);
          if (o.folder !== undefined)
            data.folderId = o.folder === 'null' ? null : o.folder;

          let content = o.content;
          if (content == null && o.fromFile) {
            content = readFileSync(o.fromFile, 'utf-8');
          }
          // Read markdown from stdin so `update <id> < file.md` works instead of
          // silently discarding the redirect and sending an empty payload. We only
          // touch stdin when the caller clearly intends content: either --from-stdin
          // was passed, or stdin is piped AND no other field was given (avoids both
          // clobbering a metadata-only update and blocking on an open, empty stdin).
          const onlyContentIntended = Object.keys(data).length === 0;
          if (content == null && (o.fromStdin || (isStdinPiped() && onlyContentIntended))) {
            const piped = await readTextStdin();
            // An empty read (e.g. `< /dev/null`) is treated as "no content" so it
            // falls through to the empty-payload guard instead of wiping the doc.
            if (piped.length > 0) content = piped;
          }
          if (content != null) data.markdownContent = content;

          // Refuse an empty update instead of sending a no-op that the API answers
          // with 200 + the unchanged document (which reads as success to callers).
          if (Object.keys(data).length === 0) {
            throw new Error(
              'Nothing to update: provide --name, --summary, --content, --from-file <path>, --project, --folder, --tags, --as-skill/--no-skill, ' +
                'or pipe markdown via `--from-stdin` (e.g. `cat file.md | devic documents update <id> --from-stdin`).',
            );
          }
        }
        return client.updateDocument(id, data);
      }, (d) => {
        const doc = d as DocumentDto;
        const lines = [
          md.success(`Document updated: ${md.b(doc.name ?? '-')}`),
        ];
        // Surface whether the content change produced a new version, so callers
        // (humans and agents) can distinguish a real update from a no-op.
        if (doc.versionCreated === true) {
          lines.push(md.success(`New version created: v${doc.currentVersion ?? '?'}`));
        } else if (doc.versionCreated === false) {
          lines.push('_No content change — document version unchanged._');
        }
        lines.push('', formatDocument(doc));
        return lines.join('\n');
      }),
    );

  // documents delete <id>
  documents
    .command('delete <documentId>')
    .description('Delete a document')
    .action(
      withAction(async (documentId: unknown) => {
        const client = createClient();
        return client.deleteDocument(documentId as string);
      }, () => md.success('Document deleted.')),
    );

  // documents subdocuments <id>
  documents
    .command('subdocuments <documentId>')
    .description('List documents referenced via @ mentions')
    .action(
      withAction(async (documentId: unknown) => {
        const client = createClient();
        return client.getDocumentSubdocuments(documentId as string);
      }, (d) => {
        const items = (d as any) ?? [];
        if (!Array.isArray(items) || items.length === 0)
          return '_No subdocuments referenced._';
        return [
          md.h(2, 'Subdocuments'),
          '',
          md.table(
            items.map((doc: any) => ({
              id: doc._id,
              name: doc.name,
              type: doc.fileType,
            })),
          ),
        ].join('\n');
      }),
    );

  // documents usage <id>
  documents
    .command('usage <documentId>')
    .description('Show which agents/assistants reference this document')
    .action(
      withAction(async (documentId: unknown) => {
        const client = createClient();
        return client.getDocumentUsage(documentId as string);
      }),
    );

  // documents attach <id> --target-type --target-id
  documents
    .command('attach <documentId>')
    .description('Attach a document to an agent or assistant')
    .requiredOption('--target-type <type>', 'agent | assistant')
    .requiredOption('--target-id <id>', 'Target entity ID')
    .action(
      withAction(async (documentId: unknown, opts: unknown) => {
        const o = opts as { targetType: string; targetId: string };
        const client = createClient();
        return client.attachDocument(
          documentId as string,
          o.targetType as 'agent' | 'assistant',
          o.targetId,
        );
      }, () => md.success('Document attached.')),
    );

  documents
    .command('detach <documentId>')
    .description('Detach a document from an agent or assistant')
    .requiredOption('--target-type <type>', 'agent | assistant')
    .requiredOption('--target-id <id>', 'Target entity ID')
    .action(
      withAction(async (documentId: unknown, opts: unknown) => {
        const o = opts as { targetType: string; targetId: string };
        const client = createClient();
        return client.detachDocument(
          documentId as string,
          o.targetType as 'agent' | 'assistant',
          o.targetId,
        );
      }, () => md.success('Document detached.')),
    );

  // ── Versions ──

  const versions = documents
    .command('versions')
    .description('Manage document versions');

  versions
    .command('list <documentId>')
    .description('List versions for a document')
    .action(
      withAction(async (documentId: unknown) => {
        const client = createClient();
        return client.listDocumentVersions(documentId as string);
      }, (d) => {
        const items = (d as any) ?? [];
        if (!Array.isArray(items) || items.length === 0)
          return '_No versions found._';
        return [
          md.h(2, 'Versions'),
          '',
          md.table(
            items.map((v: any) => ({
              version: v.version,
              changeType: v.changeType ?? '-',
              isActive: v.isActive ? '*' : '',
              createdAt: v.createdAt
                ? new Date(v.createdAt).toLocaleString()
                : '-',
              description: v.changeDescription ?? '-',
            })),
            { columns: ['version', 'changeType', 'isActive', 'createdAt', 'description'] },
          ),
        ].join('\n');
      }),
    );

  versions
    .command('get <documentId> <version>')
    .description('Get a specific document version')
    .action(
      withAction(async (documentId: unknown, version: unknown) => {
        const client = createClient();
        return client.getDocumentVersion(
          documentId as string,
          parseInt(version as string, 10),
        );
      }),
    );

  versions
    .command('revert <documentId> <version>')
    .description('Revert document to a previous version')
    .action(
      withAction(async (documentId: unknown, version: unknown) => {
        const client = createClient();
        return client.revertDocument(
          documentId as string,
          parseInt(version as string, 10),
        );
      }, () => md.success('Document reverted.')),
    );

  // ── Folders ──

  const folders = documents
    .command('folders')
    .description('Manage document folders');

  folders
    .command('list')
    .description('List document folders')
    .option('--project <project>', 'Filter by project (_id, identifier, or name)')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as { project?: string };
        const client = createClient();
        const projectId = o.project ? await resolveProjectId(client, o.project) : undefined;
        return client.listDocumentFolders({ projectId });
      }, (d) => {
        const items = (d as any) ?? [];
        if (!Array.isArray(items) || items.length === 0)
          return '_No folders found._';
        return [
          md.h(2, 'Document Folders'),
          '',
          md.table(
            items.map((f: any) => ({
              id: f._id,
              name: f.name,
              project: f.projectId || '-',
              parent: f.parentFolderId || '-',
              docs: f.documentCount ?? '-',
            })),
            { columns: ['id', 'name', 'project', 'parent', 'docs'] },
          ),
        ].join('\n');
      }),
    );

  folders
    .command('create')
    .description('Create a document folder')
    .requiredOption('--name <name>', 'Folder name')
    .option('--project <project>', 'Project scope (_id, identifier, or name)')
    .option('--parent <folderId>', 'Parent folder ID')
    .option('--color <color>', 'Color tag')
    .option('--tags <tags...>', 'Category tags')
    .option(
      '--as-skill',
      'Flag the folder as a folder-skill. Prefer `devic skills create`, which also writes the SKILL.md manifest.',
    )
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          name: string;
          project?: string;
          parent?: string;
          color?: string;
          tags?: string[];
          asSkill?: boolean;
        };
        const client = createClient();
        return client.createDocumentFolder({
          name: o.name,
          projectId: o.project ? await resolveProjectId(client, o.project) : undefined,
          parentFolderId: o.parent,
          color: o.color,
          ...(o.tags?.length ? { tags: o.tags } : {}),
          ...(o.asSkill ? { isSkill: true } : {}),
        } as any);
      }, (d) => {
        const f = d as any;
        return md.success(`Folder ${md.b(f.name)} created (${md.code(f._id)}).`);
      }),
    );

  folders
    .command('update <folderId>')
    .description('Update a folder')
    .option('--name <name>', 'New name')
    .option('--parent <folderId>', 'Parent folder ID (use "null" to unset)')
    .option('--color <color>', 'Color tag')
    .option('--project <project>', 'Project _id, identifier or name (use "null" to unset). Cascades to the whole subtree.')
    .option('--tags <tags...>', 'Category tags (replaces the current list)')
    .option('--as-skill', 'Flag the folder as a folder-skill')
    .option('--no-skill', 'Unflag the folder as a folder-skill')
    .action(
      withAction(async (folderId: unknown, opts: unknown) => {
        const o = opts as {
          name?: string;
          parent?: string;
          color?: string;
          project?: string;
          tags?: string[];
          asSkill?: boolean;
          skill?: boolean;
        };
        const client = createClient();
        const data: Record<string, unknown> = {};
        if (o.name) data.name = o.name;
        if (o.parent !== undefined)
          data.parentFolderId = o.parent === 'null' ? null : o.parent;
        if (o.color) data.color = o.color;
        if (o.project !== undefined)
          data.projectId =
            o.project === 'null' ? null : await resolveProjectId(client, o.project);
        if (o.tags?.length) data.tags = o.tags;
        if (o.asSkill) data.isSkill = true;
        else if (o.skill === false) data.isSkill = false;
        return client.updateDocumentFolder(folderId as string, data);
      }, () => md.success('Folder updated.')),
    );

  folders
    .command('delete <folderId>')
    .description('Delete a folder')
    .option(
      '--delete-documents',
      'Also delete the documents inside the folder',
    )
    .action(
      withAction(async (folderId: unknown, opts: unknown) => {
        const o = opts as { deleteDocuments?: boolean };
        const client = createClient();
        return client.deleteDocumentFolder(
          folderId as string,
          !!o.deleteDocuments,
        );
      }, () => md.success('Folder deleted.')),
    );
}
