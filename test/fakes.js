// In-memory stand-ins for Jira and Forge KVS, so the service layer can be
// tested end to end without a Forge site. They model the parts Dockside
// relies on: permissions per account, issues, labels, comments, properties,
// projects with issue types, and key-prefix queries.

export class FakeJiraError extends Error {
  constructor(status, op) {
    super(`fake jira ${op} ${status}`);
    this.status = status;
    this.op = op;
  }
}

export function createStore() {
  const map = new Map();
  return {
    map,
    async get(k) {
      return map.has(k) ? structuredClone(map.get(k)) : undefined;
    },
    async set(k, v) {
      if (!/^(?!\s+$)[a-zA-Z0-9:._\s\-#]+$/.test(k) || k.length > 500) throw new Error(`invalid KVS key: ${k}`);
      if (v === null || v === undefined) throw new Error('KVS cannot store null');
      if (JSON.stringify(v).length > 240 * 1024) throw new Error('KVS value too large');
      map.set(k, structuredClone(v));
    },
    async delete(k) {
      map.delete(k);
    },
    async list(prefix, max = 500) {
      return [...map.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, max)
        .map((k) => ({ key: k, value: structuredClone(map.get(k)) }));
    },
  };
}

export function createJiraWorld() {
  const projects = new Map();
  const issues = new Map();
  const perms = new Map(); // accountId -> Set
  const issueTypes = [
    { id: '10001', name: 'Task', hierarchyLevel: 0 },
    { id: '10002', name: 'Bug', hierarchyLevel: 0 },
    { id: '10003', name: 'Sub-task', hierarchyLevel: -1, subtask: true },
  ];
  let issueSeq = 0;
  const log = [];

  function addProject(key, { style = 'classic', types = issueTypes } = {}) {
    projects.set(key, { id: String(20000 + projects.size), key, name: `${key} kitchen`, style, issueTypes: types.map((t) => ({ ...t })) });
  }
  function grant(accountId, ...p) {
    if (!perms.has(accountId)) perms.set(accountId, new Set());
    for (const x of p) perms.get(accountId).add(x);
  }
  function addIssue({ projectKey, summary, description, typeName = 'Task', labels = [], attachments = [] }) {
    const project = projects.get(projectKey);
    issueSeq += 1;
    const key = `${projectKey}-${issueSeq}`;
    const type = project.issueTypes.find((t) => t.name === typeName) ?? project.issueTypes[0];
    issues.set(key, {
      id: String(30000 + issueSeq),
      key,
      fields: { summary, description, issuetype: { id: type.id, name: type.name }, labels: [...labels], attachment: attachments.map((a, i) => ({ id: `a${issueSeq}${i}`, filename: a.filename, size: a.body.length, created: `2026-11-0${i + 1}T08:00:00.000Z`, body: a.body })), project: { id: project.id, key: projectKey }, status: { name: 'To Do' } },
      comments: [],
      properties: {},
    });
    return key;
  }

  const has = (accountId, p) => perms.get(accountId)?.has(p) ?? false;

  function adapter(identity) {
    const isApp = identity.app === true;
    const accountId = identity.accountId;
    const broken = identity.tokenBroken === true;
    const guard = (op) => {
      log.push({ identity: isApp ? 'app' : accountId, op });
      if (broken) throw new Error('NEEDS_AUTHENTICATION_ERR: user token unavailable');
    };
    const canSee = (projectKey) => isApp || has(accountId, 'BROWSE_PROJECTS');
    const issueOr404 = (key, need) => {
      const issue = issues.get(key);
      if (!issue || !canSee(issue.fields.project.key)) throw new FakeJiraError(404, 'issue');
      if (need && !isApp && !has(accountId, need)) throw new FakeJiraError(403, 'issue');
      return issue;
    };
    return {
      async getIssue(key, fields) {
        guard('getIssue');
        const issue = issueOr404(key);
        const out = { id: issue.id, key: issue.key, fields: {} };
        for (const f of fields) if (f in issue.fields) out.fields[f] = structuredClone(issue.fields[f]);
        return out;
      },
      async getAttachmentText(id) {
        guard('getAttachment');
        for (const issue of issues.values()) {
          const a = issue.fields.attachment.find((x) => x.id === id);
          if (a && canSee(issue.fields.project.key)) return a.body;
        }
        throw new FakeJiraError(404, 'attachment');
      },
      async addComment(key, adf) {
        guard('addComment');
        const issue = issueOr404(key, 'ADD_COMMENTS');
        issue.comments.push({ author: isApp ? 'app' : accountId, body: adf });
        return { id: String(issue.comments.length) };
      },
      async updateLabels(key, { add = [], remove = [] }) {
        guard('updateLabels');
        const issue = issueOr404(key, 'EDIT_ISSUES');
        const set = new Set(issue.fields.labels);
        for (const l of remove) set.delete(l);
        for (const l of add) set.add(l);
        issue.fields.labels = [...set];
        return null;
      },
      async setIssueProperty(key, propertyKey, value) {
        guard('setIssueProperty');
        const issue = issueOr404(key, 'EDIT_ISSUES');
        issue.properties[propertyKey] = structuredClone(value);
        return null;
      },
      async createIssue(fields) {
        guard('createIssue');
        if (!isApp && !has(accountId, 'CREATE_ISSUES')) throw new FakeJiraError(403, 'createIssue');
        const project = projects.get(fields.project.key);
        const type = project.issueTypes.find((t) => t.id === fields.issuetype.id);
        if (!type) throw new FakeJiraError(400, 'createIssue');
        if (fields.labels && project.labelsNotOnScreen) throw new FakeJiraError(400, 'createIssue');
        const key = addIssue({ projectKey: project.key, summary: fields.summary, description: fields.description, typeName: type.name, labels: fields.labels ?? [] });
        return { id: issues.get(key).id, key };
      },
      async getProject(key) {
        guard('getProject');
        const p = projects.get(key);
        if (!p || !canSee(key)) throw new FakeJiraError(404, 'project');
        return structuredClone(p);
      },
      async getAllIssueTypes() {
        guard('getAllIssueTypes');
        return structuredClone(issueTypes);
      },
      async createIssueType(body) {
        guard('createIssueType');
        if (!isApp && !has(accountId, 'ADMINISTER')) throw new FakeJiraError(403, 'createIssueType');
        const t = { id: String(10100 + issueTypes.length), name: body.name, hierarchyLevel: 0 };
        issueTypes.push(t);
        for (const p of projects.values()) if (p.style === 'classic') p.issueTypes.push({ ...t });
        return t;
      },
      async getIssueTypeSchemeForProject(projectId) {
        guard('getIssueTypeScheme');
        return { values: [{ issueTypeScheme: { id: '1', name: 'Default Issue Type Scheme', isDefault: true }, projectIds: [projectId] }] };
      },
      async addIssueTypesToScheme() {
        guard('addIssueTypesToScheme');
        return null;
      },
      async myPermissions({ permissions }) {
        guard('myPermissions');
        const out = {};
        for (const p of permissions) out[p] = { havePermission: isApp || has(accountId, p) };
        return { permissions: out };
      },
      async checkPermissions(body) {
        guard('checkPermissions');
        if (!isApp) throw new FakeJiraError(403, 'checkPermissions');
        const who = body.accountId;
        const projectPermissions = (body.projectPermissions || []).flatMap((pp) =>
          pp.permissions.map((perm) => ({
            permission: perm,
            projects: (pp.projects || []).filter(() => has(who, perm)),
            issues: (pp.issues || []).filter(() => has(who, perm)),
          }))
        );
        return { projectPermissions, globalPermissions: [] };
      },
    };
  }

  return { projects, issues, perms, issueTypes, log, addProject, grant, addIssue, user: (accountId, opts = {}) => adapter({ accountId, ...opts }), app: () => adapter({ app: true }) };
}

export function fixedClock(start = '2026-11-02T09:00:00.000Z') {
  let t = Date.parse(start);
  return () => {
    t += 1000;
    return new Date(t).toISOString();
  };
}

export function seededRand() {
  let n = 0;
  return () => {
    n += 1;
    return `r${String(n).padStart(5, '0')}`;
  };
}
