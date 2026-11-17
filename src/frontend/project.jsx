// Dockside project page: every delivery note in the project, open findings,
// supplier price changes, the audit trail and settings.
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  BarChart,
  Box,
  Button,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  Toggle,
  User,
} from '@forge/react';
import { invoke, showFlag } from '@forge/bridge';
import { DecisionLozenge, errorText, formatDate, formatDateTime, formatMoney, formatPct, SEVERITY, StatusLozenge, Tile } from './ui.jsx';

const issueLink = (key) => <Link href={`/browse/${key}`}>{key}</Link>;

const EVENT_LABEL = {
  checked: 'Checked',
  approved: 'Approved',
  disputed: 'Disputed',
  marked: 'Marked as delivery note',
  'decision-cleared': 'Decision cleared',
  'settings-changed': 'Settings changed',
  'demo-seeded': 'Demo data loaded',
  'issue-type-created': 'Work type added',
  'extraction-saved': 'Agent extraction saved',
};

function FindingsTable({ findings }) {
  if (!findings.length) {
    return (
      <SectionMessage appearance="success" title="Nothing open">
        <Text>Every checked note in this project is either clean or already decided.</Text>
      </SectionMessage>
    );
  }
  const head = {
    cells: [
      { key: 'note', content: 'Note' },
      { key: 'supplier', content: 'Supplier', isSortable: true },
      { key: 'what', content: 'Finding' },
      { key: 'line', content: 'Line' },
      { key: 'amount', content: 'Before VAT', isSortable: true },
    ],
  };
  const rows = findings.map((f, i) => ({
    key: `f${i}`,
    cells: [
      { key: 'note', content: issueLink(f.issueKey) },
      { key: f.supplier ?? '', content: f.supplier ?? 'Unknown' },
      {
        key: 'what',
        content: (
          <Stack space="space.025">
            <Inline space="space.075" alignBlock="center">
              <Lozenge appearance={SEVERITY[f.severity]?.appearance}>{SEVERITY[f.severity]?.label}</Lozenge>
              <Text weight="semibold">{f.title}</Text>
            </Inline>
            <Text size="small" color="color.text.subtle">
              {f.message}
            </Text>
          </Stack>
        ),
      },
      { key: 'line', content: f.line ? String(f.line) : 'totals' },
      { key: f.amountBeforeVat, content: f.amountBeforeVat > 0 ? formatMoney(f.amountBeforeVat) : '' },
    ],
  }));
  return <DynamicTable head={head} rows={rows} rowsPerPage={10} />;
}

function NotesTable({ notes }) {
  const head = {
    cells: [
      { key: 'key', content: 'Work item' },
      { key: 'supplier', content: 'Supplier', isSortable: true },
      { key: 'number', content: 'Note' },
      { key: 'date', content: 'Date', isSortable: true },
      { key: 'status', content: 'Result' },
      { key: 'decision', content: 'Decision' },
      { key: 'amount', content: 'In dispute', isSortable: true },
    ],
  };
  const rows = notes.map((n) => ({
    key: n.issueKey,
    cells: [
      { key: 'key', content: issueLink(n.issueKey) },
      { key: n.supplier ?? '', content: n.supplier ?? 'Unknown' },
      { key: 'number', content: n.number ?? '' },
      { key: n.date ?? '', content: formatDate(n.date) },
      { key: 'status', content: <StatusLozenge status={n.status} /> },
      { key: 'decision', content: <DecisionLozenge decision={n.decision} /> },
      { key: n.amountInDispute, content: n.amountInDispute > 0 ? formatMoney(n.amountInDispute) : '' },
    ],
  }));
  return <DynamicTable head={head} rows={rows} rowsPerPage={10} />;
}

function PriceChanges({ changes }) {
  if (!changes.length) return <Text color="color.text.subtle">No price movements in the last 90 days.</Text>;
  const chart = changes.slice(0, 12).map((c) => ({ item: `${c.description ?? c.sku}`.slice(0, 24), change: c.changePct, kind: c.kind === 'pending' ? 'On open notes' : 'Accepted' }));
  const head = {
    cells: [
      { key: 'supplier', content: 'Supplier' },
      { key: 'item', content: 'Item' },
      { key: 'from', content: 'Reference' },
      { key: 'to', content: 'Now' },
      { key: 'pct', content: 'Change', isSortable: true },
      { key: 'kind', content: 'Where' },
    ],
  };
  const rows = changes.map((c, i) => ({
    key: `c${i}`,
    cells: [
      { key: 'supplier', content: c.supplierName ?? c.supplierKey },
      { key: 'item', content: `${c.description ?? ''}${c.sku ? ` (${c.sku})` : ''}` },
      { key: 'from', content: `${formatMoney(c.from.unitPrice)}${c.from.date ? `, ${formatDate(c.from.date)}` : ''}` },
      { key: 'to', content: `${formatMoney(c.to.unitPrice)}${c.to.date ? `, ${formatDate(c.to.date)}` : ''}` },
      { key: c.changePct, content: <Text color={c.changePct > 0 ? 'color.text.danger' : 'color.text.success'}>{formatPct(c.changePct)}</Text> },
      { key: 'kind', content: c.kind === 'pending' ? (c.to.issueKey ? issueLink(c.to.issueKey) : 'open note') : 'accepted history' },
    ],
  }));
  return (
    <Stack space="space.200">
      <BarChart data={chart} xAccessor="item" yAccessor="change" colorAccessor="kind" title="Price change against the reference, %" />
      <DynamicTable head={head} rows={rows} rowsPerPage={10} />
    </Stack>
  );
}

function Suppliers({ suppliers }) {
  if (!suppliers.length) return <Text color="color.text.subtle">No suppliers yet.</Text>;
  const head = {
    cells: [
      { key: 'name', content: 'Supplier' },
      { key: 'notes', content: 'Notes', isSortable: true },
      { key: 'open', content: 'Open', isSortable: true },
      { key: 'dispute', content: 'In dispute', isSortable: true },
      { key: 'max', content: 'Largest price rise' },
      { key: 'last', content: 'Last delivery' },
    ],
  };
  const rows = suppliers.map((s) => ({
    key: s.supplierKey,
    cells: [
      { key: 'name', content: s.supplierName },
      { key: s.notes, content: String(s.notes) },
      { key: s.open, content: String(s.open) },
      { key: s.inDispute, content: s.inDispute > 0 ? formatMoney(s.inDispute) : '' },
      { key: 'max', content: s.maxIncreasePct ? formatPct(s.maxIncreasePct) : '' },
      { key: 'last', content: formatDate(s.lastDelivery) },
    ],
  }));
  return <DynamicTable head={head} rows={rows} />;
}

function Activity({ audit }) {
  if (!audit.length) return <Text color="color.text.subtle">No activity yet.</Text>;
  const head = { cells: [{ key: 'when', content: 'When' }, { key: 'who', content: 'Who' }, { key: 'what', content: 'What' }, { key: 'item', content: 'Work item' }, { key: 'detail', content: 'Detail' }] };
  const rows = audit.map((a, i) => ({
    key: `a${i}`,
    cells: [
      { key: 'when', content: formatDateTime(a.at) },
      { key: 'who', content: a.by ? <User accountId={a.by} /> : <Text color="color.text.subtle">Dockside</Text> },
      { key: 'what', content: `${EVENT_LABEL[a.type] ?? a.type}${a.via === 'agent' ? ' (agent)' : ''}` },
      { key: 'item', content: a.issueKey ? issueLink(a.issueKey) : '' },
      { key: 'detail', content: a.detail ?? '' },
    ],
  }));
  return <DynamicTable head={head} rows={rows} rowsPerPage={15} />;
}

function Settings({ data, onSaved }) {
  const [threshold, setThreshold] = useState(String(data.settings.priceThresholdPct));
  const [auto, setAuto] = useState(data.settings.autoApproveClean);
  const [busy, setBusy] = useState(null);
  const canAdmin = data.permissions.canAdmin;

  const run = async (name, fn, payload, ok) => {
    setBusy(name);
    try {
      const res = await invoke(fn, payload);
      if (!res?.ok) throw new Error(res?.error ?? 'That did not work.');
      showFlag({ id: `${name}-${Date.now()}`, title: ok(res.data), type: 'success', isAutoDismiss: true });
      await onSaved();
    } catch (e) {
      showFlag({ id: `${name}-e-${Date.now()}`, title: 'Dockside', description: errorText(e), type: 'error', isAutoDismiss: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading size="xsmall">Rules</Heading>
        <Label labelFor="threshold">Flag a price when it is above the reference by more than this percentage</Label>
        <Inline space="space.100" alignBlock="center">
          <Textfield id="threshold" type="number" width="small" value={threshold} isDisabled={!canAdmin} onChange={(e) => setThreshold(e.target.value)} />
          <Text>%</Text>
        </Inline>
        <Inline space="space.100" alignBlock="center">
          <Toggle id="auto" isChecked={auto} isDisabled={!canAdmin} onChange={() => setAuto(!auto)} />
          <Label labelFor="auto">Approve clean notes automatically, so their prices become the next reference</Label>
        </Inline>
        <Text size="small" color="color.text.subtle">
          VAT rates allowed: 4%, 10% and 21% (Spain). The reference price is the agreed price list when there is one, otherwise the last approved note for the same item.
        </Text>
        <Inline>
          <Button appearance="primary" isDisabled={!canAdmin || busy === 'save'} onClick={() => run('save', 'saveSettings', { settings: { priceThresholdPct: Number(threshold), autoApproveClean: auto } }, () => 'Settings saved')}>
            {busy === 'save' ? 'Saving' : 'Save rules'}
          </Button>
        </Inline>
        {!canAdmin ? <Text size="small" color="color.text.subtlest">Only project admins can change the rules.</Text> : null}
      </Stack>

      <Stack space="space.100">
        <Heading size="xsmall">Delivery note work type</Heading>
        {data.setup.hasDeliveryNoteType ? (
          <Text>This project has a Delivery note work type. Dockside also checks any work item labelled delivery-note.</Text>
        ) : (
          <Stack space="space.100">
            <Text>Optional. Dockside checks any work item labelled delivery-note, or one you mark from its panel. A dedicated work type makes notes easier to file and filter.</Text>
            {data.setup.teamManaged ? (
              <Text size="small" color="color.text.subtle">This is a team-managed project: add a work type called "Delivery note" in Project settings, Work types.</Text>
            ) : (
              <Inline>
                <Button isDisabled={!data.permissions.isJiraAdmin || busy === 'type'} onClick={() => run('type', 'setupIssueType', {}, (d) => d.message)}>
                  {busy === 'type' ? 'Adding' : 'Add Delivery note work type'}
                </Button>
              </Inline>
            )}
            {!data.permissions.isJiraAdmin && !data.setup.teamManaged ? <Text size="small" color="color.text.subtlest">Needs a Jira admin.</Text> : null}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

function DemoBox({ data, onLoaded }) {
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const res = await invoke('seedDemo');
      if (!res?.ok) throw new Error(res?.error ?? 'Could not load the demo data.');
      showFlag({ id: `demo-${Date.now()}`, title: res.data.alreadySeeded ? 'Demo data was already loaded' : `${res.data.issues.length} demo delivery notes created`, type: 'success', isAutoDismiss: true });
      await onLoaded();
    } catch (e) {
      showFlag({ id: `demo-e-${Date.now()}`, title: 'Dockside', description: errorText(e), type: 'error', isAutoDismiss: true });
    } finally {
      setBusy(false);
    }
  };
  if (data.demo?.issues?.length) {
    return (
      <Stack space="space.100">
        <Heading size="xsmall">Demo data</Heading>
        <Text>{`Loaded on ${formatDateTime(data.demo.seededAt)}. Seven invented delivery notes from four invented suppliers: six with a known problem and one clean.`}</Text>
        <Inline space="space.100" shouldWrap>
          {data.demo.issues.map((i) => (
            <Inline key={i.issueKey} space="space.050" alignBlock="center">
              {issueLink(i.issueKey)}
              <StatusLozenge status={i.status} />
            </Inline>
          ))}
        </Inline>
      </Stack>
    );
  }
  return (
    <Stack space="space.100">
      <Heading size="xsmall">Demo data</Heading>
      <Text>Creates seven synthetic delivery notes in this project and three months of price history for four invented suppliers. No real business data is used.</Text>
      <Inline>
        <Button appearance="primary" isDisabled={busy || !data.permissions.canCreate} onClick={load}>
          {busy ? 'Creating seven notes' : 'Load demo data'}
        </Button>
      </Inline>
    </Stack>
  );
}

function App() {
  const [state, setState] = useState({ loading: true });
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await invoke('projectOverview');
      if (!res?.ok) throw new Error(res?.error ?? 'Dockside could not load this project.');
      setState({ loading: false, data: res.data });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errorText(e) }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (state.loading) {
    return (
      <Inline space="space.100" alignBlock="center">
        <Spinner size="medium" label="Loading" />
        <Text color="color.text.subtle">Loading delivery notes</Text>
      </Inline>
    );
  }
  if (state.error && !state.data) {
    return (
      <SectionMessage appearance="error" title="Dockside could not load">
        <Stack space="space.100">
          <Text>{state.error}</Text>
          <Inline>
            <Button onClick={() => load()}>Try again</Button>
          </Inline>
        </Stack>
      </SectionMessage>
    );
  }

  const d = state.data;
  const seed = async () => {
    setSeeding(true);
    try {
      const res = await invoke('seedDemo');
      if (!res?.ok) throw new Error(res?.error ?? 'Could not load the demo data.');
      showFlag({ id: `demo-${Date.now()}`, title: `${res.data.issues.length} demo delivery notes created`, type: 'success', isAutoDismiss: true });
      await load();
    } catch (e) {
      showFlag({ id: `demo-e-${Date.now()}`, title: 'Dockside', description: errorText(e), type: 'error', isAutoDismiss: true });
    } finally {
      setSeeding(false);
    }
  };

  const header = (
    <Stack space="space.050">
      <Text color="color.text.subtle">Supplier delivery notes checked against the prices you agreed, what you ordered, VAT and their own arithmetic.</Text>
    </Stack>
  );

  if (!d.notes.length) {
    return (
      <Stack space="space.300">
        {header}
        <EmptyState
          header="No delivery notes checked yet"
          description="Load the demo to see seven invented notes, one clean and six with known problems: a price rise, goods nobody ordered, butter billed but not delivered, a wrong VAT rate, a note sent twice, a hand-typed note and one with nothing to read. Or paste a real note into a work item and mark it as a delivery note."
          primaryAction={
            <Button appearance="primary" isDisabled={seeding || !d.permissions.canCreate} onClick={seed}>
              {seeding ? 'Creating seven notes' : 'Load demo data'}
            </Button>
          }
        />
        {!d.permissions.canCreate ? <Text size="small" color="color.text.subtlest">You need permission to create work items in this project to load the demo.</Text> : null}
      </Stack>
    );
  }

  const k = d.kpis;
  return (
    <Stack space="space.300">
      {header}
      <Inline space="space.150" shouldWrap>
        <Tile label="In dispute" value={formatMoney(k.inDispute)} hint="VAT included, notes not yet approved" tone={k.inDispute > 0 ? 'danger' : 'success'} />
        <Tile label="Need attention" value={String(k.needAttention)} hint={`of ${k.notesChecked} notes checked`} />
        <Tile label="Suppliers raising prices" value={String(k.suppliersRaisingPrices)} hint="last 90 days" />
        <Tile label="Price threshold" value={`${d.settings.priceThresholdPct}%`} hint="above the reference" />
      </Inline>
      <Tabs id="dockside-tabs">
        <TabList>
          <Tab>Open findings</Tab>
          <Tab>Notes</Tab>
          <Tab>Price changes</Tab>
          <Tab>Suppliers</Tab>
          <Tab>Activity</Tab>
          <Tab>Settings</Tab>
        </TabList>
        <TabPanel>
          <Box paddingBlock="space.200">
            <FindingsTable findings={d.findings} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <NotesTable notes={d.notes} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <PriceChanges changes={d.priceChanges} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <Suppliers suppliers={d.suppliers} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <Activity audit={d.audit} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <Stack space="space.400">
              <Settings data={d} onSaved={load} />
              <DemoBox data={d} onLoaded={load} />
            </Stack>
          </Box>
        </TabPanel>
      </Tabs>
      <Text size="small" color="color.text.subtlest">
        Ask the Receiving Clerk in Rovo: "Which suppliers raised prices this month?" or "What is still in dispute?"
      </Text>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
