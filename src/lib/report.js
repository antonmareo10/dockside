// Human-facing text built from a check result: the Jira comment, the dispute
// letter to the supplier and the compact payload agents receive. Deterministic.

import { bulletList, codeText, doc, paragraph, strongText, text } from './adf.js';
import { formatMoney } from './num.js';

/** FNV-1a 32-bit, used to tell whether a note changed since the last check. */
export function hashText(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const STATUS_LABELS = {
  OK: 'dockside-ok',
  REVIEW: 'dockside-review',
  DISPUTE: 'dockside-dispute',
  UNREADABLE: 'dockside-unreadable',
};

export const DECISION_LABELS = {
  accepted: 'dockside-approved',
  disputed: 'dockside-disputed',
};

const where = (d) => (d.lineNo ? `Line ${d.lineNo}` : 'Note');

function noteName(result) {
  const parts = [];
  if (result.number) parts.push(`delivery note ${result.number}`);
  else parts.push('this delivery note');
  if (result.supplier?.name) parts.push(`from ${result.supplier.name}`);
  return parts.join(' ');
}

/** Comment Dockside posts after an automatic check. */
export function checkCommentAdf(result) {
  const scored = result.discrepancies.filter((d) => d.severity !== 'info');
  const intro = paragraph(strongText('Dockside'), text(` checked ${noteName(result)}. ${result.summary}`));
  if (result.status === 'UNREADABLE') {
    return doc(
      intro,
      paragraph(text('Paste the note as text, CSV or JSON in the description, or attach it as a .txt, .csv or .json file. You can also ask the Receiving Clerk agent in Rovo to read it.'))
    );
  }
  const items = scored.slice(0, 12).map((d) => {
    const parts = [strongText(`${where(d)}: `), text(d.message)];
    if (d.disputable && d.amount > 0) parts.push(text(` (${formatMoney(d.amount)} before VAT)`));
    if (d.source) parts.push(text(' Quote: '), codeText(d.source));
    return parts;
  });
  const more = scored.length > 12 ? [paragraph(text(`And ${scored.length - 12} more in the Dockside panel.`))] : [];
  return doc(
    intro,
    items.length ? bulletList(items) : null,
    ...more,
    paragraph(text(`Rules used: price threshold ${result.settings.priceThresholdPct}%, VAT rates ${result.settings.allowedVatRates.join(', ')}%. Approve or dispute it from the Dockside panel on this work item.`))
  );
}

/** Plain-text letter to the supplier listing what is disputed. */
export function disputeLetter(result) {
  const disputable = result.discrepancies.filter((d) => d.disputable && d.amount > 0);
  const others = result.discrepancies.filter((d) => d.severity === 'error' && !(d.disputable && d.amount > 0));
  const lines = [];
  lines.push(`Hello${result.supplier?.name ? ` ${result.supplier.name}` : ''},`);
  lines.push('');
  const dated = result.date ? ` dated ${result.date}` : '';
  lines.push(`We have checked ${result.number ? `delivery note ${result.number}` : 'your delivery note'}${dated} against our order and the prices we last agreed, and found the following:`);
  lines.push('');
  let n = 1;
  for (const d of [...disputable, ...others]) {
    const item = d.description ?? d.sku ?? '';
    const head = d.lineNo ? `Line ${d.lineNo}${item ? `, ${item}` : ''}` : 'Note totals';
    const money = d.disputable && d.amount > 0 ? ` Difference: ${formatMoney(d.amount)} before VAT.` : '';
    lines.push(`${n}. ${head}: ${d.message}${money}`);
    n += 1;
  }
  lines.push('');
  if (result.amountInDispute > 0) {
    lines.push(`Total in dispute: ${formatMoney(result.amountInDispute)}${result.disputeBasis === 'gross' ? ' including VAT' : ' before VAT'}.`);
  }
  lines.push('Please send a credit note or a corrected delivery note.');
  lines.push('');
  lines.push('Thank you.');
  return lines.join('\n');
}

export function decisionCommentAdf({ decision, result, reason, letter }) {
  if (decision === 'accepted') {
    return doc(
      paragraph(strongText('Approved in Dockside. '), text(`${noteName(result)} was approved${reason ? `: ${reason}` : '.'} Its prices are now the reference for this supplier.`))
    );
  }
  return doc(
    paragraph(strongText('Disputed in Dockside. '), text(`${noteName(result)} was disputed${reason ? `: ${reason}` : '.'} Draft for the supplier:`)),
    { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: letter }] }
  );
}

/** Compact result for agents and MCP clients: no internal fields, every finding cited. */
export function agentView(result, extra = {}) {
  return {
    issueKey: result.issueKey,
    status: result.status,
    summary: result.summary,
    supplier: result.supplier?.name ?? null,
    noteNumber: result.number,
    date: result.date,
    linesRead: result.lineCount,
    amountInDispute: result.amountInDispute,
    amountBasis: result.disputeBasis === 'gross' ? 'including VAT' : 'before VAT',
    currency: result.settings.currency,
    findings: result.discrepancies.map((d) => ({
      severity: d.severity,
      code: d.code,
      line: d.lineNo,
      quote: d.source,
      message: d.message,
      amountBeforeVat: d.disputable ? d.amount : 0,
    })),
    rules: { priceThresholdPct: result.settings.priceThresholdPct, vatRates: result.settings.allowedVatRates },
    decision: result.decision ?? null,
    ...extra,
  };
}
