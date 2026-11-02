// Jira REST adapter over @forge/api. One instance per identity:
//   makeJira('user') -> api.asUser(): the person using the app, their permissions apply
//   makeJira('app')  -> api.asApp():  the app itself, for system writes and explicit permission checks
// Each call keeps route`...` inline in requestJira so `forge lint` can match it to the
// scopes in manifest.yml (read:jira-work, write:jira-work, manage:jira-configuration).

import api, { route } from '@forge/api';

export class JiraError extends Error {
  constructor(status, body, op) {
    super(`Jira ${op} failed with ${status}`);
    this.name = 'JiraError';
    this.status = status;
    this.body = body;
    this.op = op;
  }
}

// Options stay as inline object literals: the Forge linter only checks calls written that way.
const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };
const ACCEPT = { Accept: 'application/json' };

async function send(op, pending, raw = false) {
  const res = await pending;
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new JiraError(res.status, text.slice(0, 500), op);
  if (raw) return text;
  return text ? JSON.parse(text) : null;
}

export function makeJira(mode) {
  const as = () => (mode === 'app' ? api.asApp() : api.asUser());
  return {
    mode,
    getIssue: (key, fields) => send('getIssue', as().requestJira(route`/rest/api/3/issue/${key}?fields=${fields.join(',')}`, { method: 'GET', headers: ACCEPT })),
    getAttachmentText: (id) => send('getAttachment', as().requestJira(route`/rest/api/3/attachment/content/${id}`, { method: 'GET', headers: { Accept: '*/*' } }), true),
    addComment: (key, adf) => send('addComment', as().requestJira(route`/rest/api/3/issue/${key}/comment`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ body: adf }) })),
    updateLabels: (key, { add = [], remove = [] }) =>
      send('updateLabels', as().requestJira(route`/rest/api/3/issue/${key}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ update: { labels: [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))] } }) })),
    setIssueProperty: (key, propertyKey, value) => send('setIssueProperty', as().requestJira(route`/rest/api/3/issue/${key}/properties/${propertyKey}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify(value) })),
    createIssue: (fields) => send('createIssue', as().requestJira(route`/rest/api/3/issue`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ fields }) })),
    getProject: (key) => send('getProject', as().requestJira(route`/rest/api/3/project/${key}`, { method: 'GET', headers: ACCEPT })),
    getAllIssueTypes: () => send('getAllIssueTypes', as().requestJira(route`/rest/api/3/issuetype`, { method: 'GET', headers: ACCEPT })),
    createIssueType: (body) => send('createIssueType', as().requestJira(route`/rest/api/3/issuetype`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })),
    getIssueTypeSchemeForProject: (projectId) => send('getIssueTypeScheme', as().requestJira(route`/rest/api/3/issuetypescheme/project?projectId=${projectId}`, { method: 'GET', headers: ACCEPT })),
    addIssueTypesToScheme: (schemeId, issueTypeIds) => send('addIssueTypesToScheme', as().requestJira(route`/rest/api/3/issuetypescheme/${schemeId}/issuetype`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ issueTypeIds }) })),
    myPermissions: ({ projectKey, permissions }) => send('myPermissions', as().requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permissions.join(',')}`, { method: 'GET', headers: ACCEPT })),
    checkPermissions: (body) => send('checkPermissions', as().requestJira(route`/rest/api/3/permissions/check`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })),
  };
}
