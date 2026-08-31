import { describe, expect, it } from 'vitest';

import {
  NODE_CATEGORIES,
  NODE_META,
  groupNodeTypesByCategory,
  summarizeNode,
  type BuilderNode,
  type NodeType,
} from './shared';

const ALL_TYPES = Object.keys(NODE_META) as NodeType[];

function node(
  node_type: NodeType,
  config: Record<string, unknown>,
): BuilderNode {
  return { node_key: `${node_type}_1`, node_type, config };
}

describe('node categories', () => {
  it('assigns every node type to a known category', () => {
    const known = new Set(NODE_CATEGORIES.map((c) => c.id));
    for (const type of ALL_TYPES) {
      expect(known.has(NODE_META[type].category)).toBe(true);
    }
  });
});

describe('groupNodeTypesByCategory', () => {
  it('keeps the categories in NODE_CATEGORIES order and drops empty ones', () => {
    // Only messaging + flow types — the logic group must not appear.
    const groups = groupNodeTypesByCategory(['send_message', 'start', 'end']);
    expect(groups.map((g) => g.id)).toEqual(['messaging', 'flow']);
  });
  it('preserves the input order within a category', () => {
    const groups = groupNodeTypesByCategory([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].types).toEqual([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
  });

  it('partitions the full type list without losing or duplicating a type', () => {
    const grouped = groupNodeTypesByCategory(ALL_TYPES).flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe('summarizeNode — send_buttons', () => {
  const BODY =
    'If we *solve* your current marketing challenges, would you be ' +
    'comfortable investing ₹18,000 or more per month in ads?';

  function buttonsNode(
    titles: string[],
    overrides?: Partial<Record<string, unknown>>,
  ): BuilderNode {
    return node('send_buttons', {
      text: BODY,
      buttons: titles.map((title, i) => ({
        title,
        reply_id: `r${i + 1}`,
      })),
      ...overrides,
    });
  }

  it('full (canvas) preview shows ONLY the body — no button labels appended', () => {
    const preview = summarizeNode(buttonsNode(['Yes', 'No']), { full: true });
    expect(preview).toBe(BODY);
    expect(preview).not.toContain('Yes');
    expect(preview).not.toContain('No');
  });

  it('full preview with 1 button shows body only', () => {
    const preview = summarizeNode(buttonsNode(['Sure']), { full: true });
    expect(preview).toBe(BODY);
  });

  it('full preview with 3 buttons shows body only', () => {
    const preview = summarizeNode(
      buttonsNode(['Yes', 'No', 'Maybe later']),
      { full: true },
    );
    expect(preview).toBe(BODY);
    expect(preview).not.toContain('Maybe later');
  });

  it('full preview preserves multiline body text', () => {
    const preview = summarizeNode(
      buttonsNode(['Yes', 'No'], {
        text: 'Line one\n\nLine two with details',
      }),
      { full: true },
    );
    expect(preview).toBe('Line one\n\nLine two with details');
  });

  it('full preview renders {{vars.*}} placeholders untouched', () => {
    const preview = summarizeNode(
      buttonsNode(['Yes', 'No'], {
        text: 'Awesome! {{vars.name}}✨ What best describes you?',
      }),
      { full: true },
    );
    expect(preview).toBe('Awesome! {{vars.name}}✨ What best describes you?');
  });

  it('full preview with empty body returns null (buttons render in the slot list)', () => {
    expect(summarizeNode(buttonsNode(['Yes', 'No'], { text: '' }), { full: true })).toBeNull();
  });

  it('short (list view) flavor keeps the existing "body · titles" shape', () => {
    const preview = summarizeNode(buttonsNode(['Yes', 'No']));
    expect(preview).toBe(`${BODY.slice(0, 39)}… · Yes / No`);
  });
});
