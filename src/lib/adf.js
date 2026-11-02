// Atlassian Document Format helpers: read issue descriptions as plain text
// and build the comments Dockside writes. Pure functions.

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'listItem',
  'panel',
  'tableRow',
  'rule',
  'mediaSingle',
  'decisionItem',
  'taskItem',
]);

/**
 * Convert an ADF document to plain text, one block per line.
 * Code blocks keep their own line breaks; table rows become "cell | cell".
 */
export function adfToText(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  const lines = [];
  let current = '';

  const flush = () => {
    lines.push(current);
    current = '';
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'text':
        current += node.text ?? '';
        return;
      case 'hardBreak':
        flush();
        return;
      case 'mention':
        current += node.attrs?.text ?? '';
        return;
      case 'emoji':
        current += node.attrs?.text ?? node.attrs?.shortName ?? '';
        return;
      case 'inlineCard':
        current += node.attrs?.url ?? '';
        return;
      case 'codeBlock': {
        if (current) flush();
        const text = (node.content ?? []).map((c) => c.text ?? '').join('');
        for (const l of text.split(/\r?\n/)) lines.push(l);
        return;
      }
      case 'tableRow': {
        if (current) flush();
        const cells = (node.content ?? []).map((cell) => adfToText({ type: 'doc', content: cell.content ?? [] }).replace(/\n+/g, ' ').trim());
        lines.push(cells.join(' | '));
        return;
      }
      default:
        break;
    }
    for (const child of node.content ?? []) walk(child);
    if (BLOCK_TYPES.has(node.type) && current) flush();
  };

  walk(doc);
  if (current) flush();
  // Trim trailing empty lines but keep inner blank lines so line numbers stay stable.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

// ---------- builders ----------

export const text = (t, marks) => (marks ? { type: 'text', text: String(t), marks } : { type: 'text', text: String(t) });
export const strongText = (t) => text(t, [{ type: 'strong' }]);
export const codeText = (t) => text(t, [{ type: 'code' }]);
export const paragraph = (...content) => ({ type: 'paragraph', content: content.flat().filter(Boolean) });
export const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
export const bulletList = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [Array.isArray(item) ? paragraph(...item) : paragraph(item)] })),
});
export const codeBlock = (t, language = 'text') => ({ type: 'codeBlock', attrs: { language }, content: [text(t)] });
export const panel = (panelType, ...content) => ({ type: 'panel', attrs: { panelType }, content });
export const doc = (...content) => ({ type: 'doc', version: 1, content: content.flat().filter(Boolean) });
