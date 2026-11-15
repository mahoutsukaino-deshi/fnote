'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getOIDCCredential } = require('@vscode/vsce/out/oidc');

test('locked vsce uses the final Marketplace OIDC exchange contract', async () => {
  const requests = [];
  const credential = await getOIDCCredential('maoren', {
    environment: {
      GITHUB_ACTIONS: 'true',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token?existing=value',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    },
    request: async (url, request) => {
      requests.push({ url, ...request });
      return {
        statusCode: 200,
        statusMessage: 'OK',
        readBody: async () => JSON.stringify(request.method === 'GET'
          ? { value: 'github-oidc-token' } : { credential: 'marketplace-session-token' }),
      };
    },
  });
  assert.equal(credential, 'marketplace-session-token');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'GET');
  assert.equal(new URL(requests[0].url).searchParams.get('audience'), 'marketplace.visualstudio.com');
  assert.equal(new URL(requests[0].url).searchParams.get('existing'), 'value');
  assert.equal(requests[0].headers.Authorization, 'Bearer request-token');
  assert.equal(requests[1].url, 'https://marketplace.visualstudio.com/_apis/gallery/token?api-version=7.2-preview.1');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].headers.Authorization, 'FederatedToken github-oidc-token');
  assert.equal(requests[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[1].body), { publisherName: 'maoren' });
});
