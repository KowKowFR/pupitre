import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * Every API answer says its charset: Windows PowerShell 5.1 decodes a body
 * without one as ISO-8859-1, and a French "déploiement" reads "dÃ©ploiement".
 */

const { declareUtf8 } = await import('../src/lib/utf8-response.ts');

const typeOf = (init) => declareUtf8(new Response('{}', init)).headers.get('content-type');

describe('the charset of an API answer', () => {
  it('is added to JSON, JSONL and text that do not say it', () => {
    assert.equal(typeOf({ headers: { 'content-type': 'application/json' } }), 'application/json; charset=utf-8');
    assert.equal(typeOf({ headers: { 'content-type': 'application/x-ndjson' } }), 'application/x-ndjson; charset=utf-8');
    assert.equal(typeOf({ headers: { 'content-type': 'text/plain' } }), 'text/plain; charset=utf-8');
    assert.equal(typeOf({ headers: { 'content-type': 'text/event-stream' } }), 'text/event-stream; charset=utf-8');
  });

  it('leaves alone a charset already said, a binary, an empty answer', () => {
    assert.equal(typeOf({ headers: { 'content-type': 'text/plain; charset=iso-8859-1' } }), 'text/plain; charset=iso-8859-1');
    assert.equal(typeOf({ headers: { 'content-type': 'image/png' } }), 'image/png');
    assert.equal(declareUtf8(new Response(null, { status: 202 })).headers.get('content-type'), null);
  });

  it('leaves a redirect as it is', () => {
    const redirect = Response.redirect('https://pupitre.example.com/', 307);
    assert.equal(declareUtf8(redirect), redirect);
  });
});
