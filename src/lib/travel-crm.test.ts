import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAVEL_CRM_URL,
  getTravelCrmUrl,
  isValidTravelCrmUrl,
} from './travel-crm';

describe('getTravelCrmUrl', () => {
  // CASE 1 — existing account with NULL URL → default.
  it('falls back to the default when the URL is null', () => {
    expect(getTravelCrmUrl({ travel_crm_url: null })).toBe(
      DEFAULT_TRAVEL_CRM_URL,
    );
    expect(getTravelCrmUrl(null)).toBe(DEFAULT_TRAVEL_CRM_URL);
    expect(getTravelCrmUrl(undefined)).toBe(DEFAULT_TRAVEL_CRM_URL);
  });

  it('falls back to the default for empty/whitespace values', () => {
    expect(getTravelCrmUrl({ travel_crm_url: '' })).toBe(
      DEFAULT_TRAVEL_CRM_URL,
    );
    expect(getTravelCrmUrl({ travel_crm_url: '   ' })).toBe(
      DEFAULT_TRAVEL_CRM_URL,
    );
  });

  // CASE 2 — custom URL → the custom URL.
  it('uses a valid configured URL, trimmed', () => {
    expect(
      getTravelCrmUrl({ travel_crm_url: 'https://crm.example.com' }),
    ).toBe('https://crm.example.com');
    expect(
      getTravelCrmUrl({ travel_crm_url: '  https://crm.example.com/  ' }),
    ).toBe('https://crm.example.com/');
  });

  it('never returns an invalid URL — falls back to the default', () => {
    expect(getTravelCrmUrl({ travel_crm_url: 'javascript:alert(1)' })).toBe(
      DEFAULT_TRAVEL_CRM_URL,
    );
    expect(getTravelCrmUrl({ travel_crm_url: 'not a url' })).toBe(
      DEFAULT_TRAVEL_CRM_URL,
    );
  });

  it('pins the default to the Travel CRM app URL', () => {
    expect(DEFAULT_TRAVEL_CRM_URL).toBe('https://app.travelagencycrm.in');
  });
});

describe('isValidTravelCrmUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidTravelCrmUrl('https://app.travelagencycrm.in')).toBe(true);
    expect(isValidTravelCrmUrl('http://localhost:3000')).toBe(true);
  });

  // CASE 6 — invalid URLs are rejected.
  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://files.example.com',
    'not a url',
    '',
    '   ',
    '//missing-scheme.com',
  ])('rejects %j', (value) => {
    expect(isValidTravelCrmUrl(value)).toBe(false);
  });
});
