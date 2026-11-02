// Dockside service layer. Everything that touches Jira or storage goes through
// injected adapters, so this file runs the same in Forge and in the tests.
//
//   jiraUser - Jira REST calls made as the person using the app (asUser)
//   jiraApp  - Jira REST calls made as the app (asApp), for system writes
//   store    - key-value storage (Forge KVS in production, a Map in tests)

import { adfToText, codeBlock, doc, paragraph, text as adfText } from '../lib/adf.js';
import { checkDeliveryNote, normalizeSettings } from '../lib/check.js';
import { DEMO_NOTES, demoNoteText, demoSummary, seedHistory } from '../lib/demo.js';
import { entriesFromResult, mergeEntries, summarizePriceChanges } from '../lib/history.js';
import { parseDeliveryNote } from '../lib/parse.js';
import { agentView, checkCommentAdf, DECISION_LABELS, decisionCommentAdf, disputeLetter, hashText, STATUS_LABELS } from '../lib/report.js';
import { jaccard, normalize, slug, supplierKey } from '../lib/text.js';

export const DELIVERY_NOTE_TYPE = 'Delivery note';
const TYPE_NAMES = new Set(['delivery note', 'delivery notes', 'albaran', 'albaranes']);
export const MARKER_LABEL = 'delivery-note';
export const DEMO_LABEL = 'dockside-demo';
export const PROPERTY_KEY = 'dockside';
export const AGENT = { key: 'receiving-clerk', name: 'Receiving Clerk' };
const TEXT_ATTACHMENT = /\.(txt|csv|tsv|json)$/i;
const MAX_ATTACHMENT_BYTES = 200 * 1024;
const ISSUE_FIELDS = ['summary', 'description', 'issuetype', 'labels', 'attachment', 'project', 'status'];

export class AccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessError';
    this.code = 'FORBIDDEN';
  }
}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.code = 'BAD_INPUT';
  }
}

const invertTs = (iso) => String(9999999999999 - Date.parse(iso)).padStart(13, '0');

export const keys = {
  settings: (p) => `cfg#${p}`,
  result: (p, i) => `res#${p}#${i}`,
  resultPrefix: (p) => `res#${p}#`,
  history: (p, s, item) => `hist#${p}#${s}#${item}`,
  historySupplierPrefix: (p, s) => `hist#${p}#${s}#`,
  historyPrefix: (p) => `hist#${p}#`,
  duplicate: (p, s, n) => `dup#${p}#${s}#${slug(n)}`,
  marker: (i) => `mark#${i}`,
  extraction: (i) => `ext#${i}`,
  audit: (p, ts, r) => `audit#${p}#${invertTs(ts)}#${r}`,
  auditPrefix: (p) => `audit#${p}#`,
  demo: (p) => `demo#${p}`,
};

const isJiraStatus = (e, ...codes) => e && typeof e.status === 'number' && codes.includes(e.status);

export function createDockside({ jiraUser, jiraApp, store, now = () => new Date().toISOString(), rand = () => Math.random().toString(36).slice(2, 8) }) {
  // ---------- small helpers ----------

  async function getSettings(projectKey) {
    const raw = (await store.get(keys.settings(projectKey))) || {};
    return { ...normalizeSettings(raw), autoApproveClean: raw.autoApproveClean !== false };
  }

  async function audit(projectKey, event) {
    const at = now();
    const entry = { at, ...event };
    await store.set(keys.audit(projectKey, at, rand()), entry);
    return entry;
  }

  async function loadHistory(projectKey, sk) {
    const rows = await store.list(sk ? keys.historySupplierPrefix(projectKey, sk) : keys.historyPrefix(projectKey));
    return rows.flatMap((r) => r.value?.entries ?? []);
  }

  async function writeHistory(projectKey, entries) {
    const byItem = new Map();
    for (const e of entries) {
      const k = keys.history(projectKey, e.supplierKey, e.itemKey);
      if (!byItem.has(k)) byItem.set(k, []);
      byItem.get(k).push(e);
    }
    for (const [k, list] of byItem) {
      const existing = (await store.get(k))?.entries ?? [];
      await store.set(k, { entries: mergeEntries(existing, list) });
    }
  }

  async function permissions(projectKey, perms) {
    const res = await jiraUser.myPermissions({ projectKey, permissions: perms });
    const out = {};
    for (const p of perms) out[p] = Boolean(res?.permissions?.[p]?.havePermission);
    return out;
  }

  async function requireUserPermission(projectKey, perm, what) {
    const p = await permissions(projectKey, [perm]);
    if (!p[perm]) throw new AccessError(`You need the ${perm.replace(/_/g, ' ').toLowerCase()} permission in ${projectKey} to ${what}.`);
  }

  /**
   * Can this account see the project? Ask Jira as the user first. If the
   * user token is not available (a known gap for some MCP clients), ask Jira
   * as the app to check this account's permission explicitly. Never returns
   * true without one of those two answers.
   */
  async function canBrowseProject(projectKey, accountId) {
    try {
      await jiraUser.getProject(projectKey);
      return true;
    } catch (e) {
      if (isJiraStatus(e, 403, 404)) return false;
      if (!accountId) return false;
    }
    try {
      const project = await jiraApp.getProject(projectKey);
      const res = await jiraApp.checkPermissions({ accountId, projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], projects: [Number(project.id)] }] });
      const browse = (res?.projectPermissions || []).find((p) => p.permission === 'BROWSE_PROJECTS');
      return Boolean(browse?.projects?.map(Number).includes(Number(project.id)));
    } catch {
      return false;
    }
  }

  async function requireBrowse(projectKey, accountId) {
    if (!projectKey) throw new InputError('A project key is needed, for example KAN.');
    const ok = await canBrowseProject(projectKey, accountId);
    if (!ok) throw new AccessError(`No access to project ${projectKey}, or it does not exist.`);
  }

  /** Read an issue as the user; fall back to an explicit permission check when the user token is unavailable. */
  async function readIssueFor(issueKey, accountId) {
    try {
      return await jiraUser.getIssue(issueKey, ISSUE_FIELDS);
    } catch (e) {
      if (isJiraStatus(e, 403, 404)) throw new AccessError(`Work item ${issueKey} was not found or you cannot see it.`);
      if (!accountId) throw e;
    }
    const issue = await jiraApp.getIssue(issueKey, ISSUE_FIELDS);
    const res = await jiraApp.checkPermissions({ accountId, projectPermissions: [{ permissions: ['BROWSE_PROJECTS'], issues: [Number(issue.id)] }] });
    const browse = (res?.projectPermissions || []).find((p) => p.permission === 'BROWSE_PROJECTS');
    if (!browse?.issues?.map(Number).includes(Number(issue.id))) throw new AccessError(`Work item ${issueKey} was not found or you cannot see it.`);
    return issue;
  }

  function isDeliveryNote(issue, marker) {
    const typeName = normalize(issue?.fields?.issuetype?.name ?? '');
    const labels = issue?.fields?.labels ?? [];
    return TYPE_NAMES.has(typeName) || labels.includes(MARKER_LABEL) || Boolean(marker);
  }

  /** The note text: the description, or the newest text attachment when the description has no item lines. */
  async function noteTextFor(issue, jira) {
    const description = adfToText(issue.fields?.description);
    if (parseDeliveryNote(description).lines.length) return { text: description, origin: { kind: 'description' } };
    const attachments = (issue.fields?.attachment ?? [])
      .filter((a) => TEXT_ATTACHMENT.test(a.filename ?? '') && (a.size ?? 0) <= MAX_ATTACHMENT_BYTES)
      .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
    for (const a of attachments) {
      try {
        const body = await jira.getAttachmentText(a.id);
        if (parseDeliveryNote(body).lines.length) return { text: body, origin: { kind: 'attachment', name: a.filename, id: a.id } };
      } catch {
        // An unreadable attachment is skipped; the next one is tried.
      }
    }
    return { text: description, origin: { kind: 'description' } };
  }

  async function findDuplicate(projectKey, result, issueKey) {
    if (!result.number || !result.supplier?.name) return null;
    const k = keys.duplicate(projectKey, result.supplier.key, result.number);
    const existing = await store.get(k);
    if (existing && existing.issueKey !== issueKey) {
      try {
        await jiraApp.getIssue(existing.issueKey, ['summary']);
        return existing.issueKey;
      } catch (e) {
        if (!isJiraStatus(e, 404)) return existing.issueKey;
        // The first booking was deleted: this one becomes the booking.
      }
    }
    await store.set(k, { issueKey });
    return null;
  }

  function resultFingerprint(r) {
    return hashText(JSON.stringify([r.status, r.amountInDispute, r.discrepancies.map((d) => [d.code, d.lineNo, d.amount])]));
  }

  async function syncIssue(record, { comment, currentLabels = null }) {
    const effects = [];
    const run = async (op, fn) => {
      try {
        await fn();
        effects.push({ op, ok: true });
      } catch (e) {
        effects.push({ op, ok: false, error: String(e?.message ?? e).slice(0, 200) });
      }
    };
    const statusLabel = STATUS_LABELS[record.status];
    const decisionLabel = record.decision ? DECISION_LABELS[record.decision.status] : null;
    const add = [statusLabel, decisionLabel].filter(Boolean);
    const remove = [...Object.values(STATUS_LABELS), ...Object.values(DECISION_LABELS)].filter((l) => !add.includes(l));
    const labelsAlreadyRight = Array.isArray(currentLabels) && add.every((l) => currentLabels.includes(l)) && !remove.some((l) => currentLabels.includes(l));
    if (!labelsAlreadyRight) await run('labels', () => jiraApp.updateLabels(record.issueKey, { add, remove }));
    await run('property', () =>
      jiraApp.setIssueProperty(record.issueKey, PROPERTY_KEY, {
        status: record.status,
        amountInDispute: record.amountInDispute,
        discrepancies: record.counts.error + record.counts.warning,
        supplier: record.supplier?.key ?? null,
        supplierName: record.supplier?.name ?? null,
        noteNumber: record.number ?? null,
        decision: record.decision?.status ?? 'pending',
        checkedAt: record.checkedAt,
      })
    );
    if (comment) await run('comment', () => jiraApp.addComment(record.issueKey, checkCommentAdf(record)));
    return effects;
  }

  // ---------- core flow ----------

  /**
   * Check one work item and store the result.
   * @param {object} args
   * @param {string} args.issueKey
   * @param {'event'|'panel'|'agent'|'demo'} args.actor
   * @param {string|null} [args.accountId]
   * @param {object} [args.issue] already-fetched issue (skips a read)
   */
  async function analyzeIssue({ issueKey, actor, accountId = null, issue: given = null }) {
    const reader = actor === 'event' ? jiraApp : jiraUser;
    const issue = given ?? (actor === 'event' ? await jiraApp.getIssue(issueKey, ISSUE_FIELDS) : await readIssueFor(issueKey, accountId));
    const key = issue.key ?? issueKey;
    const projectKey = issue.fields.project.key;
    const marker = await store.get(keys.marker(key));
    if (!isDeliveryNote(issue, marker)) return { skipped: true, reason: 'not-a-delivery-note', issueKey: key, projectKey };

    const settings = await getSettings(projectKey);
    const { text, origin } = await noteTextFor(issue, reader);
    const textHash = hashText(text);
    let extraction = await store.get(keys.extraction(key));
    if (extraction && extraction.textHash !== textHash) {
      await store.delete(keys.extraction(key));
      extraction = null;
    }
    const note = parseDeliveryNote(extraction ? extraction.json : text);
    const sk = note.supplier ? supplierKey(note.supplier) : null;
    const history = sk ? await loadHistory(projectKey, sk) : [];
    const preliminary = checkDeliveryNote(note, { history, settings, issueKey: key, originalText: extraction ? text : null });
    const duplicateOf = await findDuplicate(projectKey, preliminary, key);
    const result = duplicateOf ? checkDeliveryNote(note, { history, settings, issueKey: key, duplicateOf, originalText: extraction ? text : null }) : preliminary;

    const previous = await store.get(keys.result(projectKey, key));
    const contentHash = hashText(`${textHash}|${extraction ? JSON.stringify(extraction.json) : ''}`);
    const at = now();
    let decision = previous?.decision ?? null;
    const events = [];
    if (decision && previous.contentHash !== contentHash) {
      events.push({ at, type: 'decision-cleared', by: null, detail: `The note changed after it was ${decision.status}; the decision was cleared.` });
      // Prices from the old version stop counting as a reference.
      await writeHistory(projectKey, entriesFromResult(previous, { issueKey: key, status: 'cleared', recordedAt: at }));
      decision = null;
    }
    events.push({ at, type: 'checked', by: accountId, actor, detail: `${result.status}: ${result.summary}` });

    const record = {
      ...result,
      issueKey: key,
      projectKey,
      title: issue.fields.summary ?? '',
      origin: extraction ? { kind: 'agent-extraction', by: extraction.by, at: extraction.at } : origin,
      contentHash,
      textHash,
      fingerprint: resultFingerprint(result),
      checkedAt: at,
      checkedBy: { actor, accountId },
      decision,
      audit: [...events.reverse(), ...(previous?.audit ?? [])].slice(0, 25),
    };

    if (!record.decision && record.status === 'OK' && settings.autoApproveClean) {
      record.decision = { status: 'accepted', by: null, auto: true, at, reason: 'Clean note, approved automatically.' };
      record.audit.unshift({ at, type: 'approved', by: null, detail: 'Clean note, approved automatically.' });
      await writeHistory(projectKey, entriesFromResult(record, { issueKey: key, status: 'accepted', recordedAt: at }));
    }

    await store.set(keys.result(projectKey, key), record);
    const changed = !previous || previous.fingerprint !== record.fingerprint;
    record.sideEffects = await syncIssue(record, { comment: changed, currentLabels: issue.fields.labels ?? null });
    if (changed) await audit(projectKey, { type: 'checked', issueKey: key, by: accountId, actor, detail: `${record.status}, ${record.amountInDispute} in dispute` });
    for (const e of events.filter((x) => x.type === 'decision-cleared')) await audit(projectKey, { ...e, issueKey: key });
    return record;
  }

  function viewOf(record) {
    if (!record) return null;
    const { sideEffects, ...rest } = record;
    return { ...rest, letter: record.status === 'DISPUTE' || record.status === 'REVIEW' ? disputeLetter(record) : null };
  }

  async function getIssueView({ issueKey, accountId }) {
    const issue = await readIssueFor(issueKey, accountId);
    const projectKey = issue.fields.project.key;
    const marker = await store.get(keys.marker(issueKey));
    const perms = await permissions(projectKey, ['EDIT_ISSUES']);
    if (!isDeliveryNote(issue, marker)) return { isDeliveryNote: false, issueKey, projectKey, canEdit: perms.EDIT_ISSUES, agent: AGENT };
    let record = await store.get(keys.result(projectKey, issueKey));
    let stale = !record;
    if (record) {
      // Issue events can take minutes to arrive; if the note changed since the last check, check it now.
      const { text } = await noteTextFor(issue, jiraUser);
      stale = record.textHash !== hashText(text);
    }
    if (stale) record = await analyzeIssue({ issueKey, actor: 'panel', accountId, issue });
    return { isDeliveryNote: true, issueKey, projectKey, canEdit: perms.EDIT_ISSUES, agent: AGENT, record: viewOf(record) };
  }

  async function recheck({ issueKey, accountId }) {
    const record = await analyzeIssue({ issueKey, actor: 'panel', accountId });
    const perms = await permissions(record.projectKey, ['EDIT_ISSUES']);
    if (record.skipped) return { isDeliveryNote: false, issueKey, projectKey: record.projectKey, canEdit: perms.EDIT_ISSUES, agent: AGENT };
    return { isDeliveryNote: true, issueKey, projectKey: record.projectKey, canEdit: perms.EDIT_ISSUES, agent: AGENT, record: viewOf(record) };
  }

  async function markAsDeliveryNote({ issueKey, accountId }) {
    const issue = await readIssueFor(issueKey, accountId);
    const projectKey = issue.fields.project.key;
    await requireUserPermission(projectKey, 'EDIT_ISSUES', 'mark work items as delivery notes');
    await store.set(keys.marker(issueKey), { projectKey, at: now(), by: accountId });
    try {
      await jiraUser.updateLabels(issueKey, { add: [MARKER_LABEL], remove: [] });
    } catch {
      // The label is a convenience for filters; the stored marker is what counts.
    }
    await audit(projectKey, { type: 'marked', issueKey, by: accountId, detail: 'Marked as a delivery note.' });
    return recheck({ issueKey, accountId });
  }

  async function decide({ issueKey, decision, reason = '', accountId, via = 'panel' }) {
    if (!['accepted', 'disputed'].includes(decision)) throw new InputError('Decision must be "accepted" or "disputed".');
    const issue = await jiraUser.getIssue(issueKey, ['project', 'summary']).catch((e) => {
      if (isJiraStatus(e, 403, 404)) throw new AccessError(`Work item ${issueKey} was not found or you cannot see it.`);
      throw e;
    });
    const projectKey = issue.fields.project.key;
    await requireUserPermission(projectKey, 'EDIT_ISSUES', 'approve or dispute delivery notes');
    const record = await store.get(keys.result(projectKey, issueKey));
    if (!record) throw new InputError(`${issueKey} has not been checked yet. Open its Dockside panel or ask the agent to check it first.`);
    if (record.status === 'UNREADABLE') throw new InputError('Nothing was read from this note, so there is nothing to approve or dispute yet.');
    const at = now();
    const cleanReason = String(reason ?? '').slice(0, 500);
    record.decision = { status: decision, by: accountId, at, reason: cleanReason || null, via };
    record.audit = [{ at, type: decision === 'accepted' ? 'approved' : 'disputed', by: accountId, detail: cleanReason || null, via }, ...(record.audit ?? [])].slice(0, 25);
    await writeHistory(projectKey, entriesFromResult(record, { issueKey, status: decision, recordedAt: at }));
    await store.set(keys.result(projectKey, issueKey), record);
    const letter = decision === 'disputed' ? disputeLetter(record) : null;
    const effects = [];
    try {
      await jiraUser.addComment(issueKey, decisionCommentAdf({ decision, result: record, reason: cleanReason, letter }));
      effects.push({ op: 'comment', ok: true });
    } catch (e) {
      effects.push({ op: 'comment', ok: false, error: String(e?.message ?? e).slice(0, 200) });
    }
    effects.push(...(await syncIssue(record, { comment: false })));
    await audit(projectKey, { type: record.decision.status === 'accepted' ? 'approved' : 'disputed', issueKey, by: accountId, via, detail: cleanReason || null });
    return { ...viewOf(record), sideEffects: effects };
  }

  // ---------- project level ----------

  async function loadResults(projectKey) {
    const rows = await store.list(keys.resultPrefix(projectKey));
    return rows.map((r) => r.value).filter(Boolean);
  }

  function openFindings(results, { supplier = null } = {}) {
    const sk = supplier ? supplierKey(supplier) : null;
    const rows = [];
    for (const r of results) {
      if (r.decision?.status === 'accepted') continue;
      if (sk && r.supplier?.key !== sk && jaccard(supplier, r.supplier?.name ?? '') < 0.5) continue;
      for (const d of r.discrepancies) {
        if (d.severity === 'info') continue;
        rows.push({
          issueKey: r.issueKey,
          supplier: r.supplier?.name ?? null,
          noteNumber: r.number,
          date: r.date,
          status: r.status,
          decision: r.decision?.status ?? 'pending',
          severity: d.severity,
          code: d.code,
          title: d.title,
          line: d.lineNo,
          quote: d.source,
          message: d.message,
          amountBeforeVat: d.disputable ? d.amount : 0,
        });
      }
    }
    return rows.sort((a, b) => (a.severity === b.severity ? b.amountBeforeVat - a.amountBeforeVat : a.severity === 'error' ? -1 : 1));
  }

  function daysAgo(n) {
    const d = new Date(Date.parse(now()) - n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  async function projectOverview({ projectKey, accountId }) {
    let project;
    try {
      project = await jiraUser.getProject(projectKey);
    } catch (e) {
      if (isJiraStatus(e, 403, 404)) throw new AccessError(`No access to project ${projectKey}, or it does not exist.`);
      throw e;
    }
    const [results, history, auditRows, settings, demo, perms] = await Promise.all([
      loadResults(projectKey),
      loadHistory(projectKey),
      store.list(keys.auditPrefix(projectKey), 30),
      getSettings(projectKey),
      store.get(keys.demo(projectKey)),
      permissions(projectKey, ['ADMINISTER_PROJECTS', 'CREATE_ISSUES', 'ADMINISTER']),
    ]);
    const live = results.filter((r) => r.decision?.status !== 'accepted');
    const inDispute = live.filter((r) => r.status === 'DISPUTE').reduce((s, r) => s + r.amountInDispute, 0);
    const changes = summarizePriceChanges({ history, results, since: daysAgo(90) });
    const bySupplier = new Map();
    for (const r of results) {
      const k = r.supplier?.key ?? 'unknown-supplier';
      if (!bySupplier.has(k)) bySupplier.set(k, { supplierKey: k, supplierName: r.supplier?.name ?? 'Unknown supplier', notes: 0, open: 0, inDispute: 0, lastDelivery: null });
      const s = bySupplier.get(k);
      s.notes += 1;
      if (r.decision?.status !== 'accepted' && r.status !== 'OK') s.open += 1;
      if (r.decision?.status !== 'accepted' && r.status === 'DISPUTE') s.inDispute = Math.round((s.inDispute + r.amountInDispute) * 100) / 100;
      if (r.date && (!s.lastDelivery || r.date > s.lastDelivery)) s.lastDelivery = r.date;
    }
    for (const c of changes.suppliers) {
      const s = bySupplier.get(c.supplierKey);
      if (s) s.maxIncreasePct = c.maxIncreasePct;
    }
    const issueTypes = project.issueTypes ?? [];
    return {
      projectKey,
      projectName: project.name,
      projectStyle: project.style ?? null,
      settings,
      permissions: { canAdmin: perms.ADMINISTER_PROJECTS, canCreate: perms.CREATE_ISSUES, isJiraAdmin: perms.ADMINISTER },
      setup: { hasDeliveryNoteType: issueTypes.some((t) => TYPE_NAMES.has(normalize(t.name))), teamManaged: project.style === 'next-gen' || project.simplified === true },
      demo: demo ?? null,
      kpis: {
        notesChecked: results.length,
        needAttention: live.filter((r) => r.status !== 'OK').length,
        inDispute: Math.round(inDispute * 100) / 100,
        suppliersRaisingPrices: changes.suppliers.filter((s) => s.pendingIncreases > 0 || s.increases > 0).length,
      },
      notes: results
        .map((r) => ({ issueKey: r.issueKey, title: r.title, supplier: r.supplier?.name ?? null, number: r.number, date: r.date, status: r.status, amountInDispute: r.amountInDispute, decision: r.decision?.status ?? 'pending', findings: r.counts.error + r.counts.warning, checkedAt: r.checkedAt }))
        .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.issueKey.localeCompare(a.issueKey)),
      findings: openFindings(results),
      priceChanges: changes.changes.slice(0, 50),
      suppliers: [...bySupplier.values()].sort((a, b) => b.inDispute - a.inDispute || b.notes - a.notes),
      audit: auditRows.map((r) => r.value),
    };
  }

  async function saveSettings({ projectKey, settings, accountId }) {
    await requireUserPermission(projectKey, 'ADMINISTER_PROJECTS', 'change Dockside settings');
    const threshold = Number(settings?.priceThresholdPct);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 50) throw new InputError('The price threshold must be a number between 0 and 50.');
    const value = { priceThresholdPct: Math.round(threshold * 10) / 10, autoApproveClean: settings?.autoApproveClean !== false };
    await store.set(keys.settings(projectKey), value);
    await audit(projectKey, { type: 'settings-changed', by: accountId, detail: `Price threshold ${value.priceThresholdPct}%, auto-approve clean notes ${value.autoApproveClean ? 'on' : 'off'}.` });
    return getSettings(projectKey);
  }

  async function setupIssueType({ projectKey, accountId }) {
    const perms = await permissions(projectKey, ['ADMINISTER']);
    if (!perms.ADMINISTER) throw new AccessError('Only a Jira admin can add the Delivery note work type.');
    const project = await jiraUser.getProject(projectKey);
    if ((project.issueTypes ?? []).some((t) => TYPE_NAMES.has(normalize(t.name)))) return { ok: true, created: false, message: 'The Delivery note work type is already in this project.' };
    if (project.style === 'next-gen' || project.simplified === true) {
      return { ok: false, created: false, message: 'This is a team-managed project. Add a "Delivery note" work type in Project settings > Work types, or keep using the delivery-note label. Dockside works with both.' };
    }
    const all = await jiraUser.getAllIssueTypes();
    let type = (all ?? []).find((t) => TYPE_NAMES.has(normalize(t.name)) && !t.scope);
    if (!type) type = await jiraUser.createIssueType({ name: DELIVERY_NOTE_TYPE, description: 'A supplier delivery note (albarán) checked by Dockside.', hierarchyLevel: 0 });
    const schemes = await jiraUser.getIssueTypeSchemeForProject(project.id);
    const scheme = schemes?.values?.[0]?.issueTypeScheme;
    if (scheme && !scheme.isDefault) {
      try {
        await jiraUser.addIssueTypesToScheme(scheme.id, [type.id]);
      } catch (e) {
        if (!isJiraStatus(e, 400)) throw e;
        // 400 means it is already in the scheme.
      }
    }
    await audit(projectKey, { type: 'issue-type-created', by: accountId, detail: `Delivery note work type ${type.id} available in ${projectKey}.` });
    return { ok: true, created: true, issueTypeId: type.id, message: 'Delivery note work type added to this project.' };
  }

  function descriptionFor(spec) {
    const body = demoNoteText(spec);
    if (spec.format === 'raw' && !/\d/.test(body)) return doc(paragraph(adfText(body)));
    return doc(codeBlock(body));
  }

  async function seedDemo({ projectKey, accountId }) {
    await requireUserPermission(projectKey, 'CREATE_ISSUES', 'create demo delivery notes');
    const existing = await store.get(keys.demo(projectKey));
    if (existing?.issues?.length) {
      for (const it of existing.issues) {
        try {
          await jiraUser.getIssue(it.issueKey, ['summary']);
          return { ...existing, alreadySeeded: true };
        } catch (e) {
          if (!isJiraStatus(e, 404)) return { ...existing, alreadySeeded: true };
        }
      }
    }
    const project = await jiraUser.getProject(projectKey);
    const types = (project.issueTypes ?? []).filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0);
    const type = types.find((t) => TYPE_NAMES.has(normalize(t.name))) ?? types.find((t) => normalize(t.name) === 'task') ?? types[0];
    if (!type) throw new InputError(`Project ${projectKey} has no work type Dockside can use for demo notes.`);

    await writeHistory(projectKey, seedHistory());
    // Create the notes in order so their keys read 1 to 7, then check them in parallel to stay
    // well inside the 25 s resolver limit. A note that repeats an earlier number is checked last.
    const createdIssues = [];
    for (const spec of DEMO_NOTES) {
      const fields = { project: { key: projectKey }, issuetype: { id: type.id }, summary: demoSummary(spec), description: descriptionFor(spec), labels: [MARKER_LABEL, DEMO_LABEL] };
      let created;
      let labels = fields.labels;
      try {
        created = await jiraUser.createIssue(fields);
      } catch (e) {
        if (!isJiraStatus(e, 400)) throw e;
        const { labels: _omit, ...noLabels } = fields;
        created = await jiraUser.createIssue(noLabels);
        labels = [];
      }
      await store.set(keys.marker(created.key), { projectKey, at: now(), by: accountId, demo: spec.id });
      const issue = { id: created.id, key: created.key, fields: { summary: fields.summary, description: fields.description, issuetype: { id: type.id, name: type.name }, labels, attachment: [], project: { id: project.id, key: projectKey } } };
      createdIssues.push({ spec, issue });
    }
    const check = async ({ spec, issue }) => {
      const record = await analyzeIssue({ issueKey: issue.key, actor: 'demo', accountId, issue });
      return { issueKey: issue.key, demo: spec.id, title: spec.title, status: record.status, amountInDispute: record.amountInDispute };
    };
    const first = await Promise.all(createdIssues.filter((c) => !c.spec.duplicateOfDemo).map(check));
    const later = [];
    for (const c of createdIssues.filter((x) => x.spec.duplicateOfDemo)) later.push(await check(c));
    const order = new Map(createdIssues.map((c, i) => [c.issue.key, i]));
    const created = [...first, ...later].sort((a, b) => order.get(a.issueKey) - order.get(b.issueKey));
    const info = { seededAt: now(), by: accountId, issueType: type.name, issues: created };
    await store.set(keys.demo(projectKey), info);
    await audit(projectKey, { type: 'demo-seeded', by: accountId, detail: `${created.length} synthetic delivery notes and the price history of 4 invented suppliers.` });
    return info;
  }

  // ---------- agent and MCP tools ----------

  async function projectKeyFrom({ projectKey, issueKey, context }) {
    if (projectKey) return String(projectKey).trim().toUpperCase();
    if (context?.jira?.projectKey) return context.jira.projectKey;
    if (issueKey && /^[A-Z][A-Z0-9_]+-\d+$/i.test(issueKey)) return issueKey.split('-')[0].toUpperCase();
    return null;
  }

  async function toolCheck({ issueKey, extractedJson, noteText, projectKey, accountId, context }) {
    const key = issueKey || context?.jira?.issueKey || null;
    if (key) {
      const issue = await readIssueFor(String(key).toUpperCase(), accountId);
      const pk = issue.fields.project.key;
      const settings = await getSettings(pk);
      const { text } = await noteTextFor(issue, jiraApp);
      let note;
      if (extractedJson) {
        try {
          note = parseDeliveryNote(JSON.parse(extractedJson));
        } catch {
          throw new InputError('extractedJson is not valid JSON.');
        }
      } else note = parseDeliveryNote(text);
      const sk = note.supplier ? supplierKey(note.supplier) : null;
      const history = sk ? await loadHistory(pk, sk) : [];
      const stored = await store.get(keys.result(pk, issue.key));
      const dup = note.number && sk ? await store.get(keys.duplicate(pk, sk, note.number)) : null;
      const duplicateOf = dup && dup.issueKey !== issue.key ? dup.issueKey : null;
      const result = checkDeliveryNote(note, { history, settings, issueKey: issue.key, duplicateOf, originalText: extractedJson ? text : null });
      const needsReading = result.status === 'UNREADABLE' || result.discrepancies.some((d) => ['PARSE_SKIPPED_LINE', 'SUBTOTAL_MISMATCH', 'MISSING_SUPPLIER', 'UNVERIFIED_SOURCE'].includes(d.code)) || note.format === 'free-text';
      return agentView(
        { ...result, decision: stored?.decision ?? null },
        { verifiedExtraction: Boolean(extractedJson) && !result.discrepancies.some((d) => d.code === 'UNVERIFIED_SOURCE'), saved: false, ...(needsReading || extractedJson ? { noteText: text.slice(0, 8000) } : {}) }
      );
    }
    if (!noteText && !extractedJson) throw new InputError('Give an issueKey, or noteText plus projectKey.');
    const pk = await projectKeyFrom({ projectKey, context });
    await requireBrowse(pk, accountId);
    const settings = await getSettings(pk);
    let note;
    try {
      note = parseDeliveryNote(extractedJson ? JSON.parse(extractedJson) : noteText);
    } catch {
      throw new InputError('extractedJson is not valid JSON.');
    }
    const sk = note.supplier ? supplierKey(note.supplier) : null;
    const history = sk ? await loadHistory(pk, sk) : [];
    const result = checkDeliveryNote(note, { history, settings, originalText: extractedJson && noteText ? noteText : null });
    return agentView(result, { projectKey: pk, saved: false });
  }

  async function toolParse({ noteText }) {
    if (!noteText) throw new InputError('noteText is required.');
    const note = parseDeliveryNote(noteText);
    return {
      format: note.format,
      supplier: note.supplier,
      number: note.number,
      date: note.date,
      lines: note.lines.map((l) => ({ line: l.lineNo, quote: l.source, sku: l.sku, description: l.description, ordered: l.ordered, qty: l.qty, received: l.received, unit: l.unit, unitPrice: l.unitPrice, vatRate: l.vatRate, lineTotal: l.lineTotal })),
      totals: { subtotal: note.totals.subtotal, vat: note.totals.vat, total: note.totals.total },
      warnings: note.warnings,
    };
  }

  async function toolPriceHistory({ projectKey, supplier, item, accountId, context }) {
    const pk = await projectKeyFrom({ projectKey, context });
    await requireBrowse(pk, accountId);
    if (!supplier) throw new InputError('supplier is required.');
    const history = await loadHistory(pk);
    const names = new Map();
    for (const e of history) names.set(e.supplierKey, e.supplierName);
    const wanted = supplierKey(supplier);
    let sk = names.has(wanted) ? wanted : null;
    if (!sk) {
      let best = 0;
      for (const [k, n] of names) {
        const s = Math.max(jaccard(supplier, n ?? ''), jaccard(supplier, k.replace(/-/g, ' ')));
        if (s > best && s >= 0.3) {
          best = s;
          sk = k;
        }
      }
    }
    if (!sk) return { projectKey: pk, supplier, found: false, knownSuppliers: [...names.values()] };
    let entries = history.filter((e) => e.supplierKey === sk);
    if (item) {
      const q = normalize(item);
      entries = entries.filter((e) => normalize(e.sku ?? '') === q || normalize(e.description ?? '').includes(q) || jaccard(item, e.description ?? '') >= 0.5);
    }
    entries.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    return {
      projectKey: pk,
      supplier: names.get(sk),
      found: entries.length > 0,
      entries: entries.slice(0, 60).map((e) => ({ date: e.date, sku: e.sku, description: e.description, unit: e.unit, unitPrice: e.unitPrice, vatRate: e.vatRate, status: e.status, issueKey: e.issueKey, noteNumber: e.noteNumber })),
    };
  }

  async function toolOpenDiscrepancies({ projectKey, supplier, accountId, context }) {
    const pk = await projectKeyFrom({ projectKey, context });
    await requireBrowse(pk, accountId);
    const results = await loadResults(pk);
    const findings = openFindings(results, { supplier: supplier || null });
    const notes = new Set(findings.map((f) => f.issueKey));
    const amount = results.filter((r) => notes.has(r.issueKey) && r.status === 'DISPUTE').reduce((s, r) => s + r.amountInDispute, 0);
    return { projectKey: pk, notesWithFindings: notes.size, amountInDisputeInclVat: Math.round(amount * 100) / 100, findings: findings.slice(0, 50) };
  }

  async function toolPriceChanges({ projectKey, days, accountId, context }) {
    const pk = await projectKeyFrom({ projectKey, context });
    await requireBrowse(pk, accountId);
    const window = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(Number(days), 730) : 90;
    const [history, results] = await Promise.all([loadHistory(pk), loadResults(pk)]);
    const changes = summarizePriceChanges({ history, results, since: daysAgo(window) });
    return { projectKey: pk, days: window, suppliers: changes.suppliers, changes: changes.changes.slice(0, 40) };
  }

  async function toolApplyExtraction({ issueKey, extractedJson, accountId, context }) {
    const key = String(issueKey || context?.jira?.issueKey || '').toUpperCase();
    if (!key) throw new InputError('issueKey is required.');
    let json;
    try {
      json = JSON.parse(extractedJson);
    } catch {
      throw new InputError('extractedJson is not valid JSON.');
    }
    const issue = await jiraUser.getIssue(key, ISSUE_FIELDS).catch((e) => {
      if (isJiraStatus(e, 403, 404)) throw new AccessError(`Work item ${key} was not found or you cannot see it.`);
      throw e;
    });
    const pk = issue.fields.project.key;
    await requireUserPermission(pk, 'EDIT_ISSUES', 'save an extraction on this work item');
    const { text } = await noteTextFor(issue, jiraUser);
    const probe = checkDeliveryNote(parseDeliveryNote(json), { originalText: text });
    const unverified = probe.discrepancies.filter((d) => d.code === 'UNVERIFIED_SOURCE');
    if (unverified.length) {
      return { saved: false, reason: 'Some extracted lines are not in the note, so nothing was saved.', unverified: unverified.map((d) => ({ line: d.lineNo, quote: d.source, message: d.message })) };
    }
    await store.set(keys.extraction(key), { json, textHash: hashText(text), at: now(), by: accountId });
    if (!(await store.get(keys.marker(key)))) await store.set(keys.marker(key), { projectKey: pk, at: now(), by: accountId });
    await audit(pk, { type: 'extraction-saved', issueKey: key, by: accountId, detail: `${probe.lineCount} lines extracted by the Receiving Clerk, every quote found in the note.` });
    const record = await analyzeIssue({ issueKey: key, actor: 'agent', accountId, issue });
    return agentView(record, { saved: true });
  }

  async function toolRecordDecision({ issueKey, decision, reason, accountId, context }) {
    const key = String(issueKey || context?.jira?.issueKey || '').toUpperCase();
    if (!key) throw new InputError('issueKey is required.');
    const d = normalize(decision);
    const mapped = ['approve', 'approved', 'accept', 'accepted'].includes(d) ? 'accepted' : ['dispute', 'disputed', 'reject', 'rejected'].includes(d) ? 'disputed' : null;
    if (!mapped) throw new InputError('decision must be "approve" or "dispute".');
    const record = await decide({ issueKey: key, decision: mapped, reason, accountId, via: 'agent' });
    return agentView(record, { saved: true, letter: record.letter ?? null });
  }

  return {
    analyzeIssue,
    getIssueView,
    recheck,
    markAsDeliveryNote,
    decide,
    projectOverview,
    saveSettings,
    setupIssueType,
    seedDemo,
    tools: {
      check: toolCheck,
      parse: toolParse,
      priceHistory: toolPriceHistory,
      openDiscrepancies: toolOpenDiscrepancies,
      priceChanges: toolPriceChanges,
      applyExtraction: toolApplyExtraction,
      recordDecision: toolRecordDecision,
    },
    _internals: { isDeliveryNote, canBrowseProject, getSettings, loadHistory },
  };
}
