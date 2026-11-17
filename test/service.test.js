// End-to-end tests of the Dockside service layer against in-memory Jira and KVS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDockside, AccessError, InputError, keys } from '../src/services/dockside.js';
import { codeBlock, doc } from '../src/lib/adf.js';
import { DEMO_NOTES, N6_AGENT_EXTRACTION } from '../src/lib/demo.js';
import { createJiraWorld, createStore, fixedClock, seededRand } from './fakes.js';

const EDITOR = 'acc-editor';
const VIEWER = 'acc-viewer';
const ADMIN = 'acc-admin';
const OUTSIDER = 'acc-outsider';

function setup({ userTokenBroken = false } = {}) {
  const world = createJiraWorld();
  world.addProject('KAN');
  world.grant(EDITOR, 'BROWSE_PROJECTS', 'EDIT_ISSUES', 'CREATE_ISSUES', 'ADD_COMMENTS');
  world.grant(VIEWER, 'BROWSE_PROJECTS');
  world.grant(ADMIN, 'BROWSE_PROJECTS', 'EDIT_ISSUES', 'CREATE_ISSUES', 'ADD_COMMENTS', 'ADMINISTER_PROJECTS', 'ADMINISTER');
  const store = createStore();
  const clock = fixedClock();
  const make = (accountId, opts = {}) => createDockside({ jiraUser: world.user(accountId, { tokenBroken: userTokenBroken, ...opts }), jiraApp: world.app(), store, now: clock, rand: seededRand() });
  return { world, store, as: make, appOnly: () => createDockside({ jiraUser: world.app(), jiraApp: world.app(), store, now: clock, rand: seededRand() }) };
}

async function seeded() {
  const ctx = setup();
  const info = await ctx.as(EDITOR).seedDemo({ projectKey: 'KAN', accountId: EDITOR });
  return { ...ctx, info, byDemo: Object.fromEntries(info.issues.map((i) => [i.demo, i.issueKey])) };
}

const dockComments = (world, key) => world.issues.get(key).comments.filter((c) => c.author === 'app');

test('Load demo data: seven notes, each with the expected verdict', async () => {
  const { info, world, store } = await seeded();
  assert.equal(info.issues.length, 7);
  const got = Object.fromEntries(info.issues.map((i) => [i.demo, [i.status, i.amountInDispute]]));
  for (const spec of DEMO_NOTES) assert.deepEqual(got[spec.id], [spec.expected.status, spec.expected.amountInDispute], spec.id);
  // Jira side effects: status label, JQL property, one Dockside comment each.
  for (const i of info.issues) {
    const issue = world.issues.get(i.issueKey);
    assert.ok(issue.fields.labels.includes('delivery-note'));
    assert.ok(issue.fields.labels.some((l) => l.startsWith('dockside-')));
    assert.equal(issue.properties.dockside.status, i.status);
    assert.equal(dockComments(world, i.issueKey).length, 1);
  }
  assert.ok((await store.list('hist#KAN#')).length >= 17);
});

test('Loading the demo twice does not create a second set', async () => {
  const { as, info } = await seeded();
  const again = await as(EDITOR).seedDemo({ projectKey: 'KAN', accountId: EDITOR });
  assert.equal(again.alreadySeeded, true);
  assert.deepEqual(again.issues.map((i) => i.issueKey), info.issues.map((i) => i.issueKey));
});

test('The duplicate note points at the first booking', async () => {
  const { as, byDemo } = await seeded();
  const view = await as(EDITOR).getIssueView({ issueKey: byDemo['n5-duplicate'], accountId: EDITOR });
  const dup = view.record.discrepancies.find((d) => d.code === 'DUPLICATE_NOTE');
  assert.match(dup.message, new RegExp(byDemo['n1-price-and-over-delivery']));
});

test('The clean note is approved automatically and feeds the reference', async () => {
  const { as, byDemo, store } = await seeded();
  const view = await as(VIEWER).getIssueView({ issueKey: byDemo['n3-clean'], accountId: VIEWER });
  assert.equal(view.record.decision.status, 'accepted');
  assert.equal(view.record.decision.auto, true);
  const beer = await store.get(keys.history('KAN', 'bebidas-cierzo', 'sku-bc-330'));
  assert.ok(beer.entries.some((e) => e.issueKey === byDemo['n3-clean'] && e.status === 'accepted'));
});

test('The unreadable note is never approved and cannot be decided', async () => {
  const { as, byDemo } = await seeded();
  const view = await as(EDITOR).getIssueView({ issueKey: byDemo['n7-unreadable'], accountId: EDITOR });
  assert.equal(view.record.status, 'UNREADABLE');
  assert.equal(view.record.decision, null);
  await assert.rejects(() => as(EDITOR).decide({ issueKey: byDemo['n7-unreadable'], decision: 'accepted', accountId: EDITOR }), InputError);
});

test('Checking again without changes does not post another comment', async () => {
  const { as, world, byDemo } = await seeded();
  const key = byDemo['n1-price-and-over-delivery'];
  await as(EDITOR).recheck({ issueKey: key, accountId: EDITOR });
  await as(EDITOR).recheck({ issueKey: key, accountId: EDITOR });
  assert.equal(dockComments(world, key).length, 1);
});

test('Approving a price makes it the new reference for the next note', async () => {
  const { as, world, byDemo } = await seeded();
  const n1 = byDemo['n1-price-and-over-delivery'];
  const res = await as(EDITOR).decide({ issueKey: n1, decision: 'accepted', reason: 'New season price agreed by phone', accountId: EDITOR });
  assert.equal(res.decision.status, 'accepted');
  assert.ok(world.issues.get(n1).comments.some((c) => c.author === EDITOR));
  assert.ok(world.issues.get(n1).fields.labels.includes('dockside-approved'));
  const next = world.addIssue({
    projectKey: 'KAN',
    summary: 'Fish again',
    labels: ['delivery-note'],
    description: doc(codeBlock(['Supplier: Pescados Rompeolas S.L.', 'Delivery note: RP-24150', 'Date: 2026-11-03', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'PES-101;Hake fillet, fresh;5;kg;13,90;10;69,50', '', 'Total: 76,45'].join('\n'))),
  });
  const r = await as(EDITOR).analyzeIssue({ issueKey: next, actor: 'panel', accountId: EDITOR });
  assert.equal(r.lines[0].reference.unitPrice, 13.9);
  assert.equal(r.lines[0].reference.issueKey, n1);
  assert.equal(r.status, 'OK');
});

test('Disputing posts a letter as the user and keeps those prices out of the reference', async () => {
  const { as, world, byDemo, store } = await seeded();
  const n4 = byDemo['n4-not-received-and-vat'];
  await as(EDITOR).decide({ issueKey: n4, decision: 'disputed', accountId: EDITOR });
  const letter = world.issues.get(n4).comments.find((c) => c.author === EDITOR);
  const text = JSON.stringify(letter.body);
  assert.match(text, /Total in dispute: €21.43 including VAT/);
  assert.match(text, /Butter block 1 kg/);
  const butter = await store.get(keys.history('KAN', 'lacteos-prado-alto', 'sku-lpa-5'));
  assert.ok(butter.entries.some((e) => e.issueKey === n4 && e.status === 'disputed'));
});

test('Editing a note after approval clears the decision and its prices', async () => {
  const { as, world, byDemo, store } = await seeded();
  const n2 = byDemo['n2-line-total-and-vat-rate'];
  await as(EDITOR).decide({ issueKey: n2, decision: 'accepted', accountId: EDITOR });
  const issue = world.issues.get(n2);
  issue.fields.description = doc(codeBlock(['Supplier: Huerta Valdeluz S.Coop.', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'HV-12;Onions, brown;10;kg;0,78;4;7,80'].join('\n')));
  const r = await as(EDITOR).analyzeIssue({ issueKey: n2, actor: 'event' });
  assert.equal(r.decision, null);
  assert.ok(r.audit.some((a) => a.type === 'decision-cleared'));
  const lettuce = await store.get(keys.history('KAN', 'huerta-valdeluz', 'sku-hv-07'));
  assert.ok(lettuce.entries.some((e) => e.issueKey === n2 && e.status === 'cleared'));
});

test('Permissions: viewers can look but not decide, outsiders see nothing', async () => {
  const { as, byDemo } = await seeded();
  const n1 = byDemo['n1-price-and-over-delivery'];
  const view = await as(VIEWER).getIssueView({ issueKey: n1, accountId: VIEWER });
  assert.equal(view.canEdit, false);
  await assert.rejects(() => as(VIEWER).decide({ issueKey: n1, decision: 'accepted', accountId: VIEWER }), AccessError);
  await assert.rejects(() => as(OUTSIDER).getIssueView({ issueKey: n1, accountId: OUTSIDER }), AccessError);
  await assert.rejects(() => as(OUTSIDER).projectOverview({ projectKey: 'KAN', accountId: OUTSIDER }), AccessError);
  await assert.rejects(() => as(EDITOR).saveSettings({ projectKey: 'KAN', settings: { priceThresholdPct: 5 }, accountId: EDITOR }), AccessError);
  await assert.rejects(() => as(EDITOR).setupIssueType({ projectKey: 'KAN', accountId: EDITOR }), AccessError);
  await assert.rejects(() => as(VIEWER).seedDemo({ projectKey: 'KAN', accountId: VIEWER }), AccessError);
});

test('Settings change the verdict, and only project admins can change them', async () => {
  const { as, byDemo } = await seeded();
  await as(ADMIN).saveSettings({ projectKey: 'KAN', settings: { priceThresholdPct: 6 }, accountId: ADMIN });
  const r = await as(EDITOR).recheck({ issueKey: byDemo['n1-price-and-over-delivery'], accountId: EDITOR });
  assert.ok(!r.record.discrepancies.some((d) => d.code === 'PRICE_ABOVE_REFERENCE'));
  await assert.rejects(() => as(ADMIN).saveSettings({ projectKey: 'KAN', settings: { priceThresholdPct: 'lots' }, accountId: ADMIN }), InputError);
});

test('Project overview adds up the open notes', async () => {
  const { as } = await seeded();
  const o = await as(VIEWER).projectOverview({ projectKey: 'KAN', accountId: VIEWER });
  assert.equal(o.kpis.notesChecked, 7);
  assert.equal(o.kpis.needAttention, 6);
  assert.equal(o.kpis.inDispute, 432.91);
  assert.ok(o.findings.length >= 10);
  assert.ok(o.priceChanges.some((c) => c.kind === 'pending' && c.description === 'Onions, brown'));
  assert.ok(o.audit.some((a) => a.type === 'demo-seeded'));
  assert.equal(o.permissions.canAdmin, false);
});

test('Delivery note work type: added once by a Jira admin', async () => {
  const { as, world } = setup();
  const r = await as(ADMIN).setupIssueType({ projectKey: 'KAN', accountId: ADMIN });
  assert.equal(r.created, true);
  assert.ok(world.projects.get('KAN').issueTypes.some((t) => t.name === 'Delivery note'));
  const again = await as(ADMIN).setupIssueType({ projectKey: 'KAN', accountId: ADMIN });
  assert.equal(again.created, false);
});

test('Team-managed projects get instructions instead of a broken setup', async () => {
  const { as, world } = setup();
  world.addProject('TM', { style: 'next-gen' });
  world.grant(ADMIN, 'BROWSE_PROJECTS');
  const r = await as(ADMIN).setupIssueType({ projectKey: 'TM', accountId: ADMIN });
  assert.equal(r.ok, false);
  assert.match(r.message, /team-managed/);
});

test('Demo notes still work when labels are not on the create screen', async () => {
  const { as, world, store } = setup();
  world.projects.get('KAN').labelsNotOnScreen = true;
  const info = await as(EDITOR).seedDemo({ projectKey: 'KAN', accountId: EDITOR });
  assert.equal(info.issues.length, 7);
  assert.ok(await store.get(keys.marker(info.issues[0].issueKey)));
  assert.equal(info.issues[0].status, 'DISPUTE');
});

test('Trigger: ordinary work items are ignored', async () => {
  const { appOnly, world } = setup();
  const key = world.addIssue({ projectKey: 'KAN', summary: 'Fix the fridge door', description: doc(codeBlock('Hinge is loose')) });
  const r = await appOnly().analyzeIssue({ issueKey: key, actor: 'event' });
  assert.equal(r.skipped, true);
  assert.equal(world.issues.get(key).comments.length, 0);
});

test('A text attachment is read when the description has no lines', async () => {
  const { as, world } = setup();
  const key = world.addIssue({
    projectKey: 'KAN',
    summary: 'Milk delivery',
    labels: ['delivery-note'],
    description: doc(codeBlock('See attached file')),
    attachments: [{ filename: 'albaran.csv', body: ['Proveedor: Lácteos Prado Alto S.L.', 'Código;Descripción;Servido;Ud;Precio;IVA;Importe', 'LPA-1;Whole milk 1 L;24;unit;0,89;4;21,36', 'Total: 22,21'].join('\n') }],
  });
  const r = await as(EDITOR).analyzeIssue({ issueKey: key, actor: 'panel', accountId: EDITOR });
  assert.equal(r.origin.kind, 'attachment');
  assert.equal(r.lineCount, 1);
});

test('Marking an ordinary work item as a delivery note checks it', async () => {
  const { as, world } = setup();
  const key = world.addIssue({ projectKey: 'KAN', summary: 'Drinks', description: doc(codeBlock(['Supplier: Bebidas Cierzo S.A.', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'BC-330;Lager beer 33cl x24;2;case;21,60;21;43,20', 'Total: 52,27'].join('\n'))) });
  const before = await as(EDITOR).getIssueView({ issueKey: key, accountId: EDITOR });
  assert.equal(before.isDeliveryNote, false);
  const after = await as(EDITOR).markAsDeliveryNote({ issueKey: key, accountId: EDITOR });
  assert.equal(after.isDeliveryNote, true);
  assert.ok(world.issues.get(key).fields.labels.includes('delivery-note'));
});

test('Project overview never adds an amount before VAT into the VAT-included total', async () => {
  const { as, world } = await seeded();
  // No VAT rate on the line or in the totals: this note can only be disputed before VAT.
  const key = world.addIssue({ projectKey: 'KAN', summary: 'Onions', labels: ['delivery-note'], description: doc(codeBlock(['Supplier: Huerta Valdeluz S.Coop.', 'Delivery note: HV-5570', '10 kg Onions, brown @ 0,92 = 9,20', 'Total 9,20'].join('\n'))) });
  const view = await as(EDITOR).getIssueView({ issueKey: key, accountId: EDITOR });
  assert.equal(view.record.disputeBasis, 'net');
  assert.equal(view.record.amountInDispute, 1.4);
  const o = await as(VIEWER).projectOverview({ projectKey: 'KAN', accountId: VIEWER });
  assert.equal(o.kpis.inDispute, 432.91);
  assert.equal(o.kpis.inDisputeBeforeVat, 1.4);
  assert.equal(o.notes.find((n) => n.issueKey === key).disputeBasis, 'net');
  const valdeluz = o.suppliers.find((s) => s.supplierKey === 'huerta-valdeluz');
  assert.deepEqual([valdeluz.inDispute, valdeluz.inDisputeBeforeVat], [4.26, 1.4]);
  const open = await as(VIEWER).tools.openDiscrepancies({ projectKey: 'KAN', supplier: 'Huerta Valdeluz', accountId: VIEWER, context: {} });
  assert.deepEqual([open.amountInDisputeInclVat, open.amountInDisputeBeforeVat], [4.26, 1.4]);
});

// ---------- Rovo agent and MCP tools ----------

test('Agent: check a hand-typed note, then verify and save its extraction', async () => {
  const { as, byDemo } = await seeded();
  const n6 = byDemo['n6-free-text'];
  const svc = as(EDITOR);
  const first = await svc.tools.check({ issueKey: n6, accountId: EDITOR, context: {} });
  assert.equal(first.status, 'DISPUTE');
  assert.ok(first.noteText.includes('1 caja tomate pera'));
  const json = JSON.stringify({ ...N6_AGENT_EXTRACTION, lines: N6_AGENT_EXTRACTION.lines.map((l) => ({ ...l, lineNo: l.lineNo })) });
  const verified = await svc.tools.check({ issueKey: n6, extractedJson: json, accountId: EDITOR, context: {} });
  assert.equal(verified.verifiedExtraction, true);
  assert.equal(verified.linesRead, 3);
  const saved = await svc.tools.applyExtraction({ issueKey: n6, extractedJson: json, accountId: EDITOR, context: {} });
  assert.equal(saved.saved, true);
  const view = await svc.getIssueView({ issueKey: n6, accountId: EDITOR });
  assert.equal(view.record.origin.kind, 'agent-extraction');
  assert.equal(view.record.lineCount, 3);
});

test('Agent: an extraction without per-line VAT rates keeps the project total VAT included', async () => {
  const { as, byDemo } = await seeded();
  const n6 = byDemo['n6-free-text'];
  const svc = as(EDITOR);
  // The hand-typed lines show no VAT rate, so the agent leaves it null; the note says "IVA 4% 1,19".
  const json = JSON.stringify({ ...N6_AGENT_EXTRACTION, lines: N6_AGENT_EXTRACTION.lines.map(({ vatRate, ...l }) => l) });
  const saved = await svc.tools.applyExtraction({ issueKey: n6, extractedJson: json, accountId: EDITOR, context: {} });
  assert.equal(saved.saved, true);
  assert.equal(saved.amountInDispute, 2.19);
  assert.equal(saved.amountBasis, 'including VAT');
  assert.ok(!saved.findings.some((f) => f.code === 'VAT_RATE_MISSING'));
  assert.ok(saved.findings.some((f) => f.code === 'VAT_RATE_FROM_TOTALS' && f.quote === 'IVA 4% 1,19'));
  assert.equal(saved.supplier, 'Huerta Valdeluz S.Coop.');
  const o = await svc.projectOverview({ projectKey: 'KAN', accountId: EDITOR });
  // 432.91 with the two lines the parser read (2.18); 2.19 once the agent adds the third line's VAT base.
  assert.equal(o.kpis.inDispute, 432.92);
  assert.equal(o.kpis.inDisputeBeforeVat, 0);
});

test('Agent: an extraction with an invented line is refused', async () => {
  const { as, byDemo, store } = await seeded();
  const n6 = byDemo['n6-free-text'];
  const bad = JSON.stringify({ ...N6_AGENT_EXTRACTION, lines: [...N6_AGENT_EXTRACTION.lines, { lineNo: 9, source: '4 kg Garlic @ 3,00 = 12,00', description: 'Garlic', qty: 4, unit: 'kg', unitPrice: 3, vatRate: 4, lineTotal: 12 }] });
  const r = await as(EDITOR).tools.applyExtraction({ issueKey: n6, extractedJson: bad, accountId: EDITOR, context: {} });
  assert.equal(r.saved, false);
  assert.equal(r.unverified.length, 1);
  assert.equal(await store.get(keys.extraction(n6)), undefined);
});

test('Agent: the current work item is used when no key is given', async () => {
  const { as, byDemo } = await seeded();
  const n1 = byDemo['n1-price-and-over-delivery'];
  const r = await as(EDITOR).tools.check({ accountId: EDITOR, context: { jira: { issueKey: n1, projectKey: 'KAN' } } });
  assert.equal(r.issueKey, n1);
  assert.equal(r.amountInDispute, 16.06);
  assert.ok(r.findings.every((f) => f.line === null || typeof f.quote === 'string'));
});

test('Agent: record a decision through the tool', async () => {
  const { as, byDemo } = await seeded();
  const r = await as(EDITOR).tools.recordDecision({ issueKey: byDemo['n4-not-received-and-vat'], decision: 'dispute', reason: 'Two kilos short', accountId: EDITOR, context: {} });
  assert.equal(r.decision.status, 'disputed');
  assert.equal(r.decision.via, 'agent');
  assert.match(r.letter, /Lácteos Prado Alto/);
  await assert.rejects(() => as(EDITOR).tools.recordDecision({ issueKey: byDemo['n4-not-received-and-vat'], decision: 'maybe', accountId: EDITOR, context: {} }), InputError);
});

test('MCP tools: price history, open findings and price changes', async () => {
  const { as } = await seeded();
  const svc = as(VIEWER);
  const h = await svc.tools.priceHistory({ projectKey: 'KAN', supplier: 'rompeolas', item: 'hake', accountId: VIEWER, context: {} });
  assert.equal(h.found, true);
  assert.equal(h.supplier, 'Pescados Rompeolas S.L.');
  assert.equal(h.entries[0].unitPrice, 13.2);
  const open = await svc.tools.openDiscrepancies({ projectKey: 'KAN', supplier: 'Lácteos Prado Alto', accountId: VIEWER, context: {} });
  assert.equal(open.notesWithFindings, 1);
  assert.equal(open.amountInDisputeInclVat, 21.43);
  const changes = await svc.tools.priceChanges({ projectKey: 'KAN', days: 30, accountId: VIEWER, context: {} });
  const onions = changes.changes.find((c) => c.description === 'Onions, brown' && c.kind === 'pending');
  assert.equal(onions.changePct, 17.9);
});

test('MCP tools: when the user token is unavailable, access is checked explicitly for that account', async () => {
  const ctx = await seeded();
  const make = (accountId) => createDockside({ jiraUser: ctx.world.user(accountId, { tokenBroken: true }), jiraApp: ctx.world.app(), store: ctx.store, now: fixedClock(), rand: seededRand() });
  const ok = await make(VIEWER).tools.openDiscrepancies({ projectKey: 'KAN', accountId: VIEWER, context: {} });
  assert.ok(ok.findings.length > 0);
  const issue = await make(VIEWER).tools.check({ issueKey: ctx.byDemo['n3-clean'], accountId: VIEWER, context: {} });
  assert.equal(issue.status, 'OK');
  const denied = make(OUTSIDER).tools.openDiscrepancies({ projectKey: 'KAN', accountId: OUTSIDER, context: {} });
  await assert.rejects(() => denied, AccessError);
  await assert.rejects(() => make(OUTSIDER).tools.check({ issueKey: ctx.byDemo['n3-clean'], accountId: OUTSIDER, context: {} }), AccessError);
  await assert.rejects(() => make(null).tools.priceHistory({ projectKey: 'KAN', supplier: 'x', accountId: null, context: {} }), AccessError);
});

test('MCP tools: check pasted text against a project without a work item', async () => {
  const { as } = await seeded();
  const r = await as(VIEWER).tools.check({ projectKey: 'KAN', noteText: ['Supplier: Huerta Valdeluz S.Coop.', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'HV-20;Lemons;5;kg;1,95;4;9,75', 'Total: 10,14'].join('\n'), accountId: VIEWER, context: {} });
  assert.equal(r.status, 'DISPUTE');
  assert.equal(r.findings[0].code, 'PRICE_ABOVE_REFERENCE');
  const parsed = await as(VIEWER).tools.parse({ noteText: '3 kg Lemons @ 1,60 = 4,80' });
  assert.equal(parsed.lines[0].unitPrice, 1.6);
});

test('Opening the panel re-checks a note that changed since the last check', async () => {
  const { as, world, byDemo } = await seeded();
  const n1 = byDemo['n1-price-and-over-delivery'];
  world.issues.get(n1).fields.description = doc(codeBlock(['Supplier: Pescados Rompeolas S.L.', 'Delivery note: RP-24117', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'PES-120;Squid, cleaned;6;kg;9,80;10;58,80', 'Total: 64,68'].join('\n')));
  const view = await as(EDITOR).getIssueView({ issueKey: n1, accountId: EDITOR });
  assert.equal(view.record.lineCount, 1);
  assert.equal(view.record.status, 'OK');
  const again = await as(EDITOR).getIssueView({ issueKey: n1, accountId: EDITOR });
  assert.equal(again.record.checkedAt, view.record.checkedAt);
});

test('Every panel response has the same shape, so buttons never vanish after an action', async () => {
  const { as, byDemo } = await seeded();
  const key = byDemo['n2-line-total-and-vat-rate'];
  const shapes = [
    await as(EDITOR).getIssueView({ issueKey: key, accountId: EDITOR }),
    await as(EDITOR).recheck({ issueKey: key, accountId: EDITOR }),
  ];
  for (const v of shapes) {
    assert.equal(v.isDeliveryNote, true);
    assert.equal(v.canEdit, true);
    assert.equal(v.agent.key, 'receiving-clerk');
    assert.equal(v.issueKey, key);
    assert.ok(v.record.discrepancies.length > 0);
  }
});
