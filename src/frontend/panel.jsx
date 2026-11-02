// Dockside issue panel: the check result for one delivery note.
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  CodeBlock,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Textfield,
  User,
} from '@forge/react';
import { invoke, rovo, showFlag } from '@forge/bridge';
import { DecisionLozenge, errorText, Finding, formatDate, formatDateTime, formatMoney, formatPct, formatQty, STATUS, StatusLozenge, Tile } from './ui.jsx';

const ORIGIN = {
  description: 'the description',
  attachment: 'an attachment',
  'agent-extraction': 'the Receiving Clerk extraction, every quote verified',
};

function LinesTable({ lines }) {
  const head = {
    cells: [
      { key: 'line', content: 'Line' },
      { key: 'item', content: 'Item' },
      { key: 'qty', content: 'Qty' },
      { key: 'price', content: 'Price' },
      { key: 'ref', content: 'Reference' },
      { key: 'vat', content: 'VAT' },
      { key: 'total', content: 'Total' },
    ],
  };
  const rows = lines.map((l) => {
    const flagged = l.flags.some((f) => ['PRICE_ABOVE_REFERENCE', 'OVER_DELIVERY', 'BILLED_NOT_RECEIVED', 'LINE_TOTAL_MISMATCH', 'VAT_RATE_INVALID', 'UNVERIFIED_SOURCE'].includes(f));
    const qty = [l.ordered !== null && l.ordered !== undefined ? `${formatQty(l.ordered)} ordered` : null, `${formatQty(l.qty)} billed`, l.received !== null && l.received !== undefined ? `${formatQty(l.received)} counted` : null].filter(Boolean).join(', ');
    return {
      key: `l${l.lineNo}`,
      cells: [
        { key: 'line', content: String(l.lineNo) },
        { key: 'item', content: <Text weight={flagged ? 'semibold' : 'regular'}>{`${l.description ?? ''}${l.sku ? ` (${l.sku})` : ''}`}</Text> },
        { key: 'qty', content: `${qty}${l.unit ? ` ${l.unit}` : ''}` },
        { key: 'price', content: formatMoney(l.unitPrice) },
        {
          key: 'ref',
          content: l.reference ? (
            <Text color={l.flags.includes('PRICE_ABOVE_REFERENCE') ? 'color.text.danger' : 'color.text.subtle'}>{`${formatMoney(l.reference.unitPrice)}${l.priceDeltaPct !== null && l.priceDeltaPct !== undefined ? ` (${formatPct(l.priceDeltaPct)})` : ''}`}</Text>
          ) : (
            <Text color="color.text.subtlest">new item</Text>
          ),
        },
        { key: 'vat', content: l.vatRate !== null && l.vatRate !== undefined ? `${l.vatRate}%` : 'none' },
        { key: 'total', content: formatMoney(l.billedTotal) },
      ],
    };
  });
  return <DynamicTable head={head} rows={rows} />;
}

function DisputeModal({ record, onClose, onConfirm, busy }) {
  const [reason, setReason] = useState('');
  return (
    <Modal onClose={onClose} width="large">
      <ModalHeader>
        <ModalTitle>Dispute this delivery note</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>Dockside will record the dispute, keep these prices out of the reference, and post this draft as a comment so you can send it to the supplier.</Text>
          <CodeBlock language="text" text={record.letter ?? ''} shouldWrapLongLines />
          <Textfield placeholder="Reason (optional), for example: called the driver, credit note promised" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <ButtonGroup>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button appearance="danger" isDisabled={busy} onClick={() => onConfirm(reason)}>
            {busy ? 'Recording' : 'Record dispute'}
          </Button>
        </ButtonGroup>
      </ModalFooter>
    </Modal>
  );
}

function Header({ record }) {
  const s = STATUS[record.status];
  const bits = [record.supplier?.name ?? 'Supplier not found', record.date ? formatDate(record.date) : 'no date on the note', `${record.lineCount} ${record.lineCount === 1 ? 'line' : 'lines'} read from ${ORIGIN[record.origin?.kind] ?? 'the description'}`];
  return (
    <Inline spread="space-between" alignBlock="start" shouldWrap>
      <Stack space="space.050">
        <Heading size="small">{record.number ? `Delivery note ${record.number}` : 'Delivery note'}</Heading>
        <Text size="small" color="color.text.subtle">
          {bits.join(' · ')}
        </Text>
      </Stack>
      <Inline space="space.100" alignBlock="center">
        {record.decision ? <DecisionLozenge decision={record.decision.status} /> : null}
        <StatusLozenge status={record.status} />
      </Inline>
    </Inline>
  );
}

function DecisionBanner({ decision }) {
  if (!decision) return null;
  if (decision.status === 'accepted') {
    return (
      <SectionMessage appearance="success" title={decision.auto ? 'Approved automatically' : 'Approved'}>
        <Inline space="space.050" alignBlock="center" shouldWrap>
          {decision.by ? <User accountId={decision.by} /> : <Text>Dockside</Text>}
          <Text>{`on ${formatDateTime(decision.at)}. These prices are now the reference for this supplier.${decision.reason && !decision.auto ? ` Reason: ${decision.reason}` : ''}`}</Text>
        </Inline>
      </SectionMessage>
    );
  }
  return (
    <SectionMessage appearance="warning" title="Disputed">
      <Inline space="space.050" alignBlock="center" shouldWrap>
        {decision.by ? <User accountId={decision.by} /> : null}
        <Text>{`on ${formatDateTime(decision.at)}${decision.via === 'agent' ? ' through the Receiving Clerk' : ''}. The draft for the supplier is in the comments.${decision.reason ? ` Reason: ${decision.reason}` : ''}`}</Text>
      </Inline>
    </SectionMessage>
  );
}

function App() {
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [rovoOn, setRovoOn] = useState(false);

  const load = useCallback(async (fn = 'getIssueView') => {
    setState((s) => ({ ...s, loading: !s.data, error: null }));
    try {
      const res = await invoke(fn);
      if (!res?.ok) throw new Error(res?.error ?? 'Dockside could not load this work item.');
      setState({ loading: false, data: res.data });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errorText(e) }));
    }
  }, []);

  useEffect(() => {
    load();
    rovo
      .isEnabled()
      .then((on) => setRovoOn(Boolean(on)))
      .catch(() => setRovoOn(false));
  }, [load]);

  const act = async (name, fn, payload, okMessage) => {
    setBusy(name);
    try {
      const res = await invoke(fn, payload);
      if (!res?.ok) throw new Error(res?.error ?? 'That did not work.');
      setState({ loading: false, data: res.data });
      if (okMessage) showFlag({ id: `${name}-${Date.now()}`, title: okMessage, type: 'success', isAutoDismiss: true });
      return true;
    } catch (e) {
      showFlag({ id: `${name}-err-${Date.now()}`, title: 'Dockside', description: errorText(e), type: 'error', isAutoDismiss: true });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const askClerk = async (issueKey) => {
    try {
      await rovo.open({ type: 'forge', agentKey: 'receiving-clerk', agentName: 'Receiving Clerk', prompt: `Check delivery note ${issueKey} and tell me what to dispute.` });
    } catch (e) {
      showFlag({ id: `rovo-${Date.now()}`, title: 'Rovo is not available here', description: errorText(e), type: 'warning', isAutoDismiss: true });
    }
  };

  if (state.loading) {
    return (
      <Inline space="space.100" alignBlock="center">
        <Spinner size="medium" label="Checking" />
        <Text color="color.text.subtle">Checking this delivery note against your price history</Text>
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

  const data = state.data;
  if (!data.isDeliveryNote) {
    return (
      <EmptyState
        header="Not a delivery note yet"
        description="Dockside checks supplier delivery notes against the prices you agreed, what you ordered, Spanish VAT rates and the note's own totals. Paste the note in the description as text, CSV or JSON, then check it here."
        primaryAction={
          data.canEdit ? (
            <Button appearance="primary" isDisabled={busy === 'mark'} onClick={() => act('mark', 'markAsDeliveryNote', {}, 'Checked as a delivery note')}>
              {busy === 'mark' ? 'Checking' : 'Check as delivery note'}
            </Button>
          ) : null
        }
      />
    );
  }

  const r = data.record;
  const s = STATUS[r.status];
  const findings = r.discrepancies.filter((d) => d.severity !== 'info');
  const notes = r.discrepancies.filter((d) => d.severity === 'info');
  const canDecide = data.canEdit && r.status !== 'UNREADABLE';

  return (
    <Stack space="space.200">
      <Header record={r} />

      {r.status === 'UNREADABLE' ? (
        <SectionMessage appearance="warning" title={s.headline}>
          <Stack space="space.100">
            <Text>Dockside found no item lines, so it checked nothing and will not mark this note as fine. It reads tables pasted as text (CSV, columns, or a table copied from a PDF), simple lines like "12 kg Hake @ 13,90", and JSON, in the description or in a .txt, .csv or .json attachment.</Text>
            {rovoOn ? <Text>Handwritten or messy? Ask the Receiving Clerk to read it. Dockside then verifies every line it extracts against the note.</Text> : null}
          </Stack>
        </SectionMessage>
      ) : (
        <Inline space="space.150" shouldWrap>
          <Tile label={s.headline} value={formatMoney(r.amountInDispute)} hint={r.disputeBasis === 'gross' ? 'in dispute, VAT included' : 'in dispute, before VAT'} tone={r.amountInDispute > 0 ? 'danger' : 'success'} />
          <Tile label="Findings" value={String(r.counts.error + r.counts.warning)} hint={`${r.counts.error} to dispute, ${r.counts.warning} to check`} />
          <Tile label="Billed total" value={formatMoney(r.totals?.billed?.total)} hint={r.totals?.stated?.total === null ? 'not written on the note' : 'as written on the note'} />
        </Inline>
      )}

      <DecisionBanner decision={r.decision} />

      {findings.length ? (
        <Stack space="space.100">
          <Heading size="xsmall">What Dockside found</Heading>
          {findings.map((d) => (
            <Finding key={d.id} d={d} />
          ))}
        </Stack>
      ) : r.status === 'OK' ? (
        <SectionMessage appearance="success" title="No findings">
          <Text>{r.summary}</Text>
        </SectionMessage>
      ) : null}

      {notes.length ? (
        <Stack space="space.050">
          <Text size="small" weight="semibold" color="color.text.subtle">
            Also noted
          </Text>
          {notes.map((d) => (
            <Text key={d.id} size="small" color="color.text.subtle">{`${d.lineNo ? `Line ${d.lineNo}: ` : ''}${d.message}`}</Text>
          ))}
        </Stack>
      ) : null}

      {r.lines.length ? (
        <Stack space="space.100">
          <Heading size="xsmall">Lines</Heading>
          <LinesTable lines={r.lines} />
        </Stack>
      ) : null}

      <Inline space="space.100" shouldWrap>
        {canDecide && r.decision?.status !== 'accepted' ? (
          <Button appearance="primary" isDisabled={Boolean(busy)} onClick={() => act('approve', 'decide', { decision: 'accepted' }, 'Approved. Prices saved as reference.')}>
            {busy === 'approve' ? 'Approving' : 'Approve'}
          </Button>
        ) : null}
        {canDecide && r.decision?.status !== 'disputed' && r.status !== 'OK' ? (
          <Button appearance="warning" isDisabled={Boolean(busy)} onClick={() => setDisputeOpen(true)}>
            Dispute
          </Button>
        ) : null}
        <Button appearance="subtle" isDisabled={Boolean(busy)} onClick={() => act('recheck', 'recheck', {}, 'Checked again')}>
          {busy === 'recheck' ? 'Checking' : 'Check again'}
        </Button>
        {rovoOn ? (
          <Button appearance="discovery" onClick={() => askClerk(data.issueKey)}>
            Ask the Receiving Clerk
          </Button>
        ) : null}
      </Inline>

      <Text size="small" color="color.text.subtlest">
        {`Checked ${formatDateTime(r.checkedAt)}. Rules: price threshold ${r.settings.priceThresholdPct}%, VAT ${r.settings.allowedVatRates.join(' / ')}%. Every figure comes from the note and this project's accepted price history; nothing on this panel is guessed by a model.`}
      </Text>

      <ModalTransition>
        {disputeOpen ? (
          <DisputeModal
            record={r}
            busy={busy === 'dispute'}
            onClose={() => setDisputeOpen(false)}
            onConfirm={async (reason) => {
              const ok = await act('dispute', 'decide', { decision: 'disputed', reason }, 'Dispute recorded. Draft posted as a comment.');
              if (ok) setDisputeOpen(false);
            }}
          />
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
