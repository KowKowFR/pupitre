import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * What the exports and the sessions list promise, checked on the pure modules
 * that carry it: the CSV cells a spreadsheet must not execute, the URL the list
 * and the export share, a device's name.
 */

const { csvCell, csvRow } = await import('../src/lib/csv.ts');
const { filterParams } = await import('../src/app/(app)/deployments/filters.ts');
const { describeUserAgent } = await import('../src/lib/user-agent.ts');
const { compactIp } = await import('../src/lib/ip.ts');

describe('exports CSV', () => {
  it('neutralizes what a spreadsheet would execute as a formula', () => {
    for (const value of ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', '\tx', '\rx']) {
      assert.ok(csvCell(value).replace(/^"/, '').startsWith("'"), `not neutralized: ${value}`);
    }
  });

  it('leaves negative numbers as is: they are data, not text', () => {
    assert.equal(csvCell(-3), '-3');
  });

  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('dit "non"'), '"dit ""non"""');
    assert.equal(csvCell('ligne\nsuivante'), '"ligne\nsuivante"');
  });

  it('writes an empty cell for null, and ends the line with CRLF', () => {
    assert.equal(csvRow([129, null, 'docs', undefined]), '129,,docs,\r\n');
  });
});

describe('runs list filters', () => {
  it('translates "blocked by a scan" into blocked=scan, not into a status', () => {
    assert.equal(filterParams('scan_blocked', '').toString(), 'blocked=scan');
  });

  it('keeps status and search together, for the list as for the export', () => {
    assert.equal(filterParams('failed', '#127').toString(), 'status=failed&q=%23127');
  });

  it('writes nothing without a filter', () => {
    assert.equal(filterParams(null, '').toString(), '');
  });
});

describe('a session’s device', () => {
  it('names browser, major version and system', () => {
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      ),
      'Firefox 131 · Linux',
    );
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
      'Safari 17 · iPhone',
    );
  });

  it('does not mistake Edge for Chrome, which it imitates', () => {
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      ),
      'Edge 129 · Windows',
    );
  });

  it('shows the first token of an agent that is not a browser', () => {
    assert.equal(describeUserAgent('curl/8.4.0'), 'curl/8.4.0');
    assert.equal(describeUserAgent('   '), null);
    assert.equal(describeUserAgent(null), null);
  });
});

describe('a session’s address', () => {
  it('shortens an IPv6 written in full', () => {
    assert.equal(compactIp('0000:0000:0000:0000:0000:0000:0000:0001'), '::1');
    assert.equal(compactIp('0000:0000:0000:0000:0000:0000:0000:0000'), '::');
    assert.equal(compactIp('2001:0db8:0000:0000:0000:ff00:0042:8329'), '2001:db8::ff00:42:8329');
  });

  it('lets an IPv4, an already short IPv6, and nothing through', () => {
    assert.equal(compactIp('192.168.10.12'), '192.168.10.12');
    assert.equal(compactIp('fe80::1'), 'fe80::1');
    assert.equal(compactIp(null), null);
  });
});

const { expandDayRange, zonedDayStart } = await import('../src/lib/day-range.ts');

describe('log filter days', () => {
  it('reads a day in the instance’s time zone, not in UTC', () => {
    assert.equal(zonedDayStart('2026-09-30', 'Europe/Paris')?.toISOString(), '2026-09-29T22:00:00.000Z');
    assert.equal(zonedDayStart('2026-09-30', 'UTC')?.toISOString(), '2026-09-30T00:00:00.000Z');
  });

  it('accounts for the daylight saving change', () => {
    // Daylight saving time on March 29, 2026 at 2 a.m.: midnight is still UTC+1.
    assert.equal(zonedDayStart('2026-03-29', 'Europe/Paris')?.toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(zonedDayStart('2026-03-30', 'Europe/Paris')?.toISOString(), '2026-03-29T22:00:00.000Z');
  });

  it('makes "To" cover the whole day', () => {
    const range = expandDayRange({ from: '2026-09-29', to: '2026-09-30', action: 'x' }, 'Europe/Paris');
    assert.equal(range.from, '2026-09-28T22:00:00.000Z');
    assert.equal(range.to, '2026-09-30T21:59:59.999Z');
    assert.equal(range.action, 'x');
  });

  it('leaves an ISO instant as is, and falls back on UTC for an unknown time zone', () => {
    const iso = '2026-09-30T08:30:00.000Z';
    assert.equal(expandDayRange({ to: iso }, 'Europe/Paris').to, iso);
    assert.equal(zonedDayStart('2026-09-30', 'Nulle/Part')?.toISOString(), '2026-09-30T00:00:00.000Z');
  });
});
