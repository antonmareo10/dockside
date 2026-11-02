// Forge entry points. Thin wrappers: identity and context come from Forge,
// everything else lives in services/dockside.js.
//
//   handler        -> UI resolvers for jira:issuePanel and jira:projectPage
//   onIssueEvent   -> trigger on avi:jira:created:issue / avi:jira:updated:issue
//   action*        -> Rovo actions, shared by the rovo:agent and the rovo:mcp module

import Resolver from '@forge/resolver';
import { makeJira } from './forge/jira.js';
import { forgeStore } from './forge/store.js';
import { AccessError, createDockside, InputError } from './services/dockside.js';

const dockside = () => createDockside({ jiraUser: makeJira('user'), jiraApp: makeJira('app'), store: forgeStore });

function failure(e) {
  if (e instanceof AccessError || e instanceof InputError) return { ok: false, code: e.code, error: e.message };
  if (e && typeof e.status === 'number') {
    console.error(`Jira call failed: ${e.op} ${e.status} ${e.body ?? ''}`);
    if (e.status === 401 || e.status === 403) return { ok: false, code: 'FORBIDDEN', error: 'Jira did not allow that with your permissions.' };
    if (e.status === 404) return { ok: false, code: 'NOT_FOUND', error: 'Jira could not find that work item or project.' };
    return { ok: false, code: 'JIRA_ERROR', error: `Jira returned an error (${e.status}). Try again in a moment.` };
  }
  console.error('Dockside error', e?.stack ?? e);
  return { ok: false, code: 'ERROR', error: 'Dockside hit an unexpected error. Try again in a moment.' };
}

const wrap = (fn) => async (req) => {
  try {
    return { ok: true, data: await fn(req) };
  } catch (e) {
    return failure(e);
  }
};

const issueKeyOf = (req) => req.context?.extension?.issue?.key;
const projectKeyOf = (req) => req.context?.extension?.project?.key;
const accountOf = (req) => req.context?.accountId ?? null;

const resolver = new Resolver();
// Issue panel. The issue always comes from the Forge context, never from the payload.
resolver.define('getIssueView', wrap((req) => dockside().getIssueView({ issueKey: issueKeyOf(req), accountId: accountOf(req) })));
resolver.define('recheck', wrap((req) => dockside().recheck({ issueKey: issueKeyOf(req), accountId: accountOf(req) })));
resolver.define('markAsDeliveryNote', wrap((req) => dockside().markAsDeliveryNote({ issueKey: issueKeyOf(req), accountId: accountOf(req) })));
resolver.define(
  'decide',
  wrap(async (req) => {
    const svc = dockside();
    await svc.decide({ issueKey: issueKeyOf(req), decision: req.payload?.decision, reason: req.payload?.reason, accountId: accountOf(req) });
    return svc.getIssueView({ issueKey: issueKeyOf(req), accountId: accountOf(req) });
  })
);
// Project page. The project always comes from the Forge context.
resolver.define('projectOverview', wrap((req) => dockside().projectOverview({ projectKey: projectKeyOf(req), accountId: accountOf(req) })));
resolver.define('saveSettings', wrap((req) => dockside().saveSettings({ projectKey: projectKeyOf(req), settings: req.payload?.settings, accountId: accountOf(req) })));
resolver.define('setupIssueType', wrap((req) => dockside().setupIssueType({ projectKey: projectKeyOf(req), accountId: accountOf(req) })));
resolver.define('seedDemo', wrap((req) => dockside().seedDemo({ projectKey: projectKeyOf(req), accountId: accountOf(req) })));

export const handler = resolver.getDefinitions();

/** Trigger: check a delivery note when it is created or edited. Runs as the app. */
export async function onIssueEvent(event) {
  const issueKey = event?.issue?.key;
  if (!issueKey || event?.selfGenerated) return;
  try {
    const r = await dockside().analyzeIssue({ issueKey, actor: 'event', accountId: event?.atlassianId ?? null });
    if (!r.skipped) console.log(`Dockside checked ${issueKey}: ${r.status}`);
  } catch (e) {
    console.error(`Dockside trigger failed for ${issueKey}`, e?.status ?? '', e?.message ?? e);
  }
}

// ---------- Rovo actions (agent + MCP tools) ----------

const accountFrom = (context) => context?.principal?.accountId ?? context?.accountId ?? null;

const action = (fn) => async (payload, context) => {
  const accountId = accountFrom(context);
  try {
    return await fn({ ...(payload ?? {}), accountId, context: payload?.context ?? {} });
  } catch (e) {
    const f = failure(e);
    return { error: f.error, code: f.code };
  }
};

export const actionCheckDeliveryNote = action((p) => dockside().tools.check(p));
export const actionParseDeliveryNote = action((p) => dockside().tools.parse(p));
export const actionPriceHistory = action((p) => dockside().tools.priceHistory(p));
export const actionOpenDiscrepancies = action((p) => dockside().tools.openDiscrepancies(p));
export const actionPriceChanges = action((p) => dockside().tools.priceChanges(p));
export const actionApplyExtraction = action((p) => dockside().tools.applyExtraction(p));
export const actionRecordDecision = action((p) => dockside().tools.recordDecision(p));
