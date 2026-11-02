// Shared UI pieces for the Dockside panel and project page (Forge UI Kit).
import React from 'react';
import { Box, Inline, Lozenge, Stack, Text, xcss } from '@forge/react';
import { formatMoney, formatPct, formatQty } from '../lib/num.js';

export { formatMoney, formatPct, formatQty };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso) {
  if (!iso) return 'no date';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const t = String(iso);
  return `${formatDate(t)}, ${t.slice(11, 16)} UTC`;
}

export const STATUS = {
  OK: { label: 'Matches', appearance: 'success', headline: 'Everything on this note matches' },
  REVIEW: { label: 'Check', appearance: 'moved', headline: 'Worth a second look' },
  DISPUTE: { label: 'Dispute', appearance: 'removed', headline: 'Money in dispute' },
  UNREADABLE: { label: 'Not read', appearance: 'default', headline: 'Nothing could be read yet' },
};

export const DECISION = {
  accepted: { label: 'Approved', appearance: 'success' },
  disputed: { label: 'Disputed', appearance: 'removed' },
  pending: { label: 'Pending', appearance: 'default' },
};

export const SEVERITY = {
  error: { label: 'Dispute', appearance: 'removed' },
  warning: { label: 'Check', appearance: 'moved' },
  info: { label: 'Note', appearance: 'default' },
};

export function StatusLozenge({ status }) {
  const s = STATUS[status] ?? STATUS.UNREADABLE;
  return (
    <Lozenge appearance={s.appearance} isBold>
      {s.label}
    </Lozenge>
  );
}

export function DecisionLozenge({ decision }) {
  const d = DECISION[decision] ?? DECISION.pending;
  return <Lozenge appearance={d.appearance}>{d.label}</Lozenge>;
}

export const cardStyle = xcss({
  padding: 'space.150',
  borderRadius: 'border.radius.200',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderColor: 'color.border',
  backgroundColor: 'elevation.surface',
});

export const tileStyle = xcss({
  padding: 'space.200',
  borderRadius: 'border.radius.200',
  backgroundColor: 'color.background.neutral',
  minWidth: '160px',
  flexGrow: 1,
});

export const quoteStyle = xcss({
  paddingInline: 'space.100',
  paddingBlock: 'space.050',
  borderRadius: 'border.radius',
  backgroundColor: 'color.background.neutral',
});

export function Tile({ label, value, hint, tone }) {
  const color = tone === 'danger' ? 'color.text.danger' : tone === 'success' ? 'color.text.success' : 'color.text';
  return (
    <Box xcss={tileStyle}>
      <Stack space="space.050">
        <Text size="small" color="color.text.subtle">
          {label}
        </Text>
        <Text size="large" weight="bold" color={color}>
          {value}
        </Text>
        {hint ? (
          <Text size="small" color="color.text.subtlest">
            {hint}
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
}

/** One finding: what is wrong, where, the quoted line and the money at stake. */
export function Finding({ d }) {
  const sev = SEVERITY[d.severity] ?? SEVERITY.info;
  const where = d.lineNo ? `Line ${d.lineNo}` : 'Note totals';
  return (
    <Box xcss={cardStyle}>
      <Stack space="space.075">
        <Inline spread="space-between" alignBlock="center" shouldWrap>
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={sev.appearance}>{sev.label}</Lozenge>
            <Text weight="semibold">{d.title}</Text>
            <Text size="small" color="color.text.subtlest">
              {where}
            </Text>
          </Inline>
          {d.disputable && d.amount > 0 ? (
            <Text weight="bold" color="color.text.danger">
              {formatMoney(d.amount)}
            </Text>
          ) : null}
        </Inline>
        <Text>{d.message}</Text>
        {d.source ? (
          <Box xcss={quoteStyle}>
            <Text size="small" color="color.text.subtle">
              {d.source}
            </Text>
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}

export function errorText(e) {
  if (!e) return 'Something went wrong.';
  if (typeof e === 'string') return e;
  return e.message || 'Something went wrong.';
}
