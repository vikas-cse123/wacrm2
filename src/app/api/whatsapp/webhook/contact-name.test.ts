import { describe, expect, it } from 'vitest';

import { resolveInboundContactName } from './route';

// Regression coverage for the production crash:
//   TypeError: Cannot read properties of undefined (reading 'name')
// Meta does not guarantee `contacts[].profile` on every inbound
// payload, so the name resolution must never throw and must fall
// back to the normalized sender phone.
describe('resolveInboundContactName', () => {
  const phone = '916387495389';

  it('profile.name present → uses the profile name', () => {
    expect(
      resolveInboundContactName(
        { profile: { name: 'Interscale Marketing' }, wa_id: phone },
        phone,
      ),
    ).toBe('Interscale Marketing');
  });

  it('profile missing → uses the sender phone', () => {
    expect(resolveInboundContactName({ wa_id: phone }, phone)).toBe(phone);
  });

  it('contact missing → uses the sender phone', () => {
    expect(resolveInboundContactName(undefined, phone)).toBe(phone);
    expect(resolveInboundContactName(null, phone)).toBe(phone);
  });

  it('empty profile.name → effective creation name is the sender phone', () => {
    const extracted = resolveInboundContactName(
      { profile: { name: '' }, wa_id: phone },
      phone,
    );
    // `??` passes '' through; findOrCreateContact maps falsy names to
    // the phone downstream (`name || phone` on insert, skipped rename
    // on update), so the effective name is the phone.
    expect(extracted || phone).toBe(phone);
  });

  it('Meta-shaped webhook payload without profile does not throw', () => {
    // Mirrors Meta batching: N messages can share a single contacts
    // entry, and that entry may carry no profile at all.
    const messages = [{ id: 'wamid.1' }, { id: 'wamid.2' }];
    const contacts: Array<{ profile?: { name?: string }; wa_id: string }> = [
      { wa_id: phone },
    ];

    const names = messages.map((_, i) => {
      // Same pairing expression as processWebhook (route.ts).
      const contact = contacts[i] || contacts[0];
      return resolveInboundContactName(contact, phone);
    });

    expect(names).toEqual([phone, phone]);
  });
});
