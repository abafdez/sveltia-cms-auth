import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { runInNewContext } from 'node:vm';

import worker from '../src/index.js';

const WORKER = 'https://auth.example.workers.dev';
const SITE = 'https://www.example.com';
const ALLOWED_DOMAINS = 'www.example.com';
const github = { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', ALLOWED_DOMAINS };
const gitlab = { GITLAB_CLIENT_ID: 'gl-id', GITLAB_CLIENT_SECRET: 'gl-secret', ALLOWED_DOMAINS };

/**
 * Call the worker.
 * @param {string} path - Path and query.
 * @param {RequestInit} [init] - Request options.
 * @param {Record<string, string>} [env] - Environment variables.
 * @returns {Promise<Response>} Response.
 */
const call = (path, init = {}, env = github) =>
  worker.fetch(new Request(`${WORKER}${path}`, init), env);

/**
 * Requests the worker sent to GitHub or GitLab, answered by `reply`.
 * @type {{ url: string, body: Record<string, string> }[]}
 */
let sent = [];
/** @type {Record<string, unknown>} */
let reply = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  reply = { access_token: 'new-token' };

  /**
   * Stand-in for GitHub’s and GitLab’s token endpoints: records the request, sends `reply`.
   * @param {string} url - Request URL.
   * @param {{ body: string }} init - Request options, with a JSON body.
   * @returns {Promise<Response>} The reply.
   */
  // @ts-ignore
  globalThis.fetch = async (url, { body }) => {
    sent.push({ url: String(url), body: JSON.parse(body) });

    return Response.json(reply);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

/**
 * Start a sign-in and return where it redirects to, and the cookie it sets.
 * @param {string} provider - Backend name.
 * @param {Record<string, string>} [env] - Environment variables.
 * @returns {Promise<{ location: URL, cookie: string }>} Redirect.
 */
const signIn = async (provider, env) => {
  const response = await call(`/auth?provider=${provider}&site_id=www.example.com`, {}, env);

  assert.equal(response.status, 302);

  return {
    location: new URL(/** @type {string} */ (response.headers.get('Location'))),
    cookie: /** @type {string} */ (response.headers.get('Set-Cookie')).split(';')[0],
  };
};

/**
 * Sign in, then come back from the provider with a code.
 * @param {string} provider - Backend name.
 * @param {Record<string, string>} env - Environment variables.
 * @returns {Promise<Response>} Callback response.
 */
const comeBack = async (provider, env) => {
  const { location, cookie } = await signIn(provider, env);
  const state = location.searchParams.get('state');

  return call(`/callback?code=the-code&state=${state}`, { headers: { Cookie: cookie } }, env);
};

/**
 * The message the callback page would post to the CMS.
 * @param {Response} response - Callback response.
 * @returns {Promise<{ state: string, content: Record<string, string> }>} Message.
 */
const readMessage = async (response) => {
  const html = await response.text();
  // The string literal it's posted as, whichever quotes it's in, evaluated as the page would
  const [, literal] = html.match(/postMessage\(\s*(["']authorization:[^\n]+["']),\n/) ?? [];
  // eslint-disable-next-line no-new-func
  const message = new Function(`return ${literal}`)();
  const [, state, content] = message.match(/^authorization:[a-z]+:(\w+):(.+)$/);

  return { state, content: JSON.parse(content) };
};

/**
 * Sign in to get a sealed refresh token, as the CMS would.
 * @param {string} [provider] - Backend name.
 * @param {Record<string, string>} [env] - Environment variables.
 * @returns {Promise<string>} Sealed refresh token.
 */
const getRefreshToken = async (provider = 'github', env = github) => {
  reply = { access_token: 'token', refresh_token: 'raw-refresh-token' };

  const { content } = await readMessage(await comeBack(provider, env));

  sent = [];

  return content.refreshToken;
};

/**
 * Send a refresh request from a page.
 * @param {string} refreshToken - Refresh token.
 * @param {object} [options] - Options.
 * @param {Record<string, string>} [options.env] - Environment variables.
 * @param {string} [options.path] - Where to send it.
 * @param {string} [options.origin] - Origin of the page.
 * @returns {Promise<Response>} Response.
 */
const refresh = (refreshToken, { env = github, path = '/auth', origin = SITE } = {}) =>
  call(
    path,
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: '',
        refresh_token: refreshToken,
      }),
    },
    env,
  );

describe('ALLOWED_DOMAINS', () => {
  const { ALLOWED_DOMAINS: _, ...withoutDomains } = github;

  it('is required to sign in', async () => {
    const response = await call(
      '/auth?provider=github&site_id=www.example.com',
      {},
      withoutDomains,
    );

    assert.equal(response.status, 200);
    assert.equal((await readMessage(response)).content.errorCode, 'MISCONFIGURED_DOMAINS');
  });

  it('is required to exchange a code, even mid-sign-in', async () => {
    const { location, cookie } = await signIn('github');
    const state = location.searchParams.get('state');

    const response = await call(
      `/callback?code=the-code&state=${state}`,
      { headers: { Cookie: cookie } },
      withoutDomains,
    );

    assert.equal((await readMessage(response)).content.errorCode, 'MISCONFIGURED_DOMAINS');
    assert.equal(sent.length, 0);
  });

  it('is required to refresh a token', async () => {
    const response = await refresh(await getRefreshToken(), { env: withoutDomains });

    assert.equal(response.status, 403);
    assert.equal(sent.length, 0);
  });

  it('turns away a site that is not on the list', async () => {
    const response = await call('/auth?provider=github&site_id=evil.example.org');

    assert.equal((await readMessage(response)).content.errorCode, 'UNSUPPORTED_DOMAIN');
  });
});

describe('sign-in with PKCE', () => {
  it('sends a code challenge to github.com, keeping the verifier in the cookie', async () => {
    const { location, cookie } = await signIn('github');
    const [, verifier] = cookie.match(/^csrf-token=github_[0-9a-f]{32}_([0-9a-f]{64})$/) ?? [];

    assert.ok(verifier, cookie);
    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      location.searchParams.get('code_challenge'),
      createHash('sha256').update(verifier).digest('base64url'),
    );
    assert.ok(!location.href.includes(verifier));
  });

  it('leaves PKCE out for GitHub Enterprise Server', async () => {
    const { location, cookie } = await signIn('github', {
      ...github,
      GITHUB_HOSTNAME: 'git.example.com',
    });

    assert.match(cookie, /^csrf-token=github_[0-9a-f]{32}$/);
    assert.equal(location.hostname, 'git.example.com');
    assert.equal(location.searchParams.get('code_challenge'), null);
  });

  it('sends GitLab the redirect URI and a code challenge', async () => {
    const { location } = await signIn('gitlab', gitlab);

    assert.equal(location.searchParams.get('redirect_uri'), `${WORKER}/callback`);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  });
});

describe('callback', () => {
  it('exchanges the code with the verifier, and passes on a sealed refresh token', async () => {
    reply = { access_token: 'ghu_token', refresh_token: 'ghr_refresh' };

    const { content, state } = await readMessage(await comeBack('github', github));
    const [{ url, body }] = sent;

    assert.equal(url, 'https://github.com/login/oauth/access_token');
    assert.equal(body.code, 'the-code');
    assert.equal(body.client_secret, 'gh-secret');
    assert.match(body.code_verifier, /^[0-9a-f]{64}$/);
    assert.equal(state, 'success');
    assert.equal(content.token, 'ghu_token');
    assert.match(content.refreshToken, /^github:[\w-]+$/);
    assert.ok(!content.refreshToken.includes('ghr_refresh'));
  });

  it('works as before with an OAuth app, which issues no refresh token', async () => {
    reply = { access_token: 'gho_token' };

    const { content } = await readMessage(await comeBack('github', github));

    assert.deepEqual(content, { provider: 'github', token: 'gho_token' });
  });

  it('sends GitLab the redirect URI and the grant type', async () => {
    await comeBack('gitlab', gitlab);

    assert.equal(sent[0].body.grant_type, 'authorization_code');
    assert.equal(sent[0].body.redirect_uri, `${WORKER}/callback`);
  });

  it('still refuses a state that is not the one in the cookie', async () => {
    const { cookie } = await signIn('github');

    const response = await call('/callback?code=x&state=0123456789abcdef0123456789abcdef', {
      headers: { Cookie: cookie },
    });

    assert.equal((await readMessage(response)).content.errorCode, 'CSRF_DETECTED');
    assert.equal(sent.length, 0);
  });

  it('hands the token only to a page on ALLOWED_DOMAINS, and an error to anyone', async () => {
    /**
     * Run the callback page’s script in a stand-in window, opened by a page on `origin`.
     * @param {Response} response - Callback response.
     * @param {string} origin - Origin of the page that opened the popup.
     * @returns {Promise<{ message: string, targetOrigin: string }[]>} What it posted back to it.
     */
    const runPopup = async (response, origin) => {
      const html = await response.text();
      const [, script] = html.match(/<script[^>]*>([\s\S]*)<\/script>/) ?? [];
      /** @type {{ message: string, targetOrigin: string }[]} */
      const posted = [];
      /** @type {((event: { data: string, origin: string }) => void) | undefined} */
      let onMessage;

      const window = {
        opener: {
          /**
           * Record a message.
           * @param {string} message - Message.
           * @param {string} targetOrigin - Target origin.
           * @returns {number} Number of messages so far.
           */
          postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
        },
        /**
         * Keep the message listener.
         * @param {string} _type - Event type.
         * @param {(event: { data: string, origin: string }) => void} listener - Listener.
         */
        addEventListener: (_type, listener) => {
          onMessage = listener;
        },
      };

      runInNewContext(script, { window, URL });
      onMessage?.({ data: 'authorizing:github', origin });

      return posted.slice(1); // after the popup’s own `authorizing:github`
    };

    reply = { access_token: 'ghu_token' };

    const toSite = await runPopup(await comeBack('github', github), SITE);
    const toOther = await runPopup(await comeBack('github', github), 'https://evil.example.org');

    const toSubdomain = await runPopup(
      await comeBack('github', github),
      'https://www.example.com.evil.org',
    );

    assert.equal(toSite.length, 1);
    assert.equal(toSite[0].targetOrigin, SITE);
    assert.match(toSite[0].message, /"token":"ghu_token"/);
    assert.deepEqual(toOther, []);
    assert.deepEqual(toSubdomain, []);

    reply = { error: 'access_denied' };

    const error = await runPopup(await comeBack('github', github), 'https://evil.example.org');

    assert.match(error[0].message, /^authorization:github:error:/);
  });

  it('keeps the page from being cached, framed, or running any other script', async () => {
    const response = await comeBack('github', github);
    const html = await response.text();
    const [, nonce] = html.match(/<script nonce="([0-9a-f]{32})">/) ?? [];
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    assert.ok(nonce);
    assert.ok(csp.includes(`script-src 'nonce-${nonce}'`), csp);
    assert.ok(csp.includes("default-src 'none'"), csp);
    assert.ok(csp.includes("frame-ancestors 'none'"), csp);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  });

  it('keeps an error message from breaking out of the page’s script', async () => {
    reply = { error: `it's </script><script>alert(1)</script>` };

    const response = await comeBack('github', github);
    const html = await response.clone().text();

    assert.equal(html.match(/<\/script>/g)?.length, 1);
    assert.equal((await readMessage(response)).content.error, reply.error);
  });
});

describe('token refresh', () => {
  it('exchanges a sealed GitHub refresh token, adding the secret', async () => {
    const refreshToken = await getRefreshToken();

    reply = { access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 };

    const response = await refresh(refreshToken);
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.equal(result.access_token, 'ghu_new');
    assert.equal(result.expires_in, 28800);
    assert.match(result.refresh_token, /^github:[\w-]+$/);
    assert.ok(!result.refresh_token.includes('ghr_new'));
    assert.deepEqual(sent, [
      {
        url: 'https://github.com/login/oauth/access_token',
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'raw-refresh-token',
          client_id: 'gh-id',
          client_secret: 'gh-secret',
        },
      },
    ]);
  });

  it('answers on every path Sveltia CMS may send it to', async () => {
    const refreshToken = await getRefreshToken();

    const responses = await Promise.all(
      ['/auth', '/oauth/access_token', '/oauth/token'].map((path) =>
        refresh(refreshToken, { path }),
      ),
    );

    assert.deepEqual(
      responses.map(({ status }) => status),
      [200, 200, 200],
    );
  });

  it('sends GitLab the redirect URI too', async () => {
    await refresh(await getRefreshToken('gitlab', gitlab), { env: gitlab });

    assert.equal(sent[0].url, 'https://gitlab.com/oauth/token');
    assert.equal(sent[0].body.redirect_uri, `${WORKER}/callback`);
  });

  it('stops 24 hours after signing in, however many times it was refreshed', async () => {
    mock.timers.enable({ apis: ['Date'], now: 0 });

    const first = await getRefreshToken();

    reply = { access_token: 'ghu_new', refresh_token: 'ghr_new' };
    mock.timers.tick(23 * 3600 * 1000);

    const second = await (await refresh(first)).json();

    assert.ok(second.refresh_token);
    mock.timers.tick(2 * 3600 * 1000);
    sent = [];

    const late = await refresh(second.refresh_token);

    assert.equal(late.status, 400);
    assert.deepEqual(await late.json(), { error: 'invalid_grant' });
    assert.equal(sent.length, 0);
  });

  it('refuses a token it did not seal, without asking GitHub', async () => {
    const refreshToken = await getRefreshToken();
    const tampered = `${refreshToken.slice(0, -2)}${refreshToken.endsWith('AA') ? 'BB' : 'AA'}`;
    const otherSecret = await getRefreshToken('github', { ...github, GITHUB_CLIENT_SECRET: 'x' });

    const responses = await Promise.all(
      [
        tampered,
        otherSecret,
        refreshToken.replace(/^github:/, 'gitlab:'),
        'github:raw-refresh-token',
        'ghr_untagged',
        'bitbucket:x',
      ].map((token) => refresh(token, { env: { ...github, ...gitlab } })),
    );

    assert.deepEqual(
      responses.map(({ status }) => status),
      [400, 400, 400, 400, 400, 400],
    );
    assert.equal(sent.length, 0);
  });

  it('answers the CORS preflight for an allowed site only', async () => {
    /**
     * Send a CORS preflight request from a page.
     * @param {string} origin - Origin of the page.
     * @returns {Promise<Response>} Response.
     */
    const preflight = (origin) =>
      call(
        '/auth',
        { method: 'OPTIONS', headers: { Origin: origin } },
        { ...github, ALLOWED_DOMAINS: '*.example.com' },
      );

    const allowed = await preflight(SITE);

    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.equal(allowed.headers.get('Access-Control-Allow-Methods'), 'POST');

    const other = await preflight('https://evil.example.org');

    assert.equal(other.status, 403);
    assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('refuses a page on another site, without asking GitHub', async () => {
    const response = await refresh(await getRefreshToken(), { origin: 'https://evil.example.org' });

    assert.equal(response.status, 403);
    assert.equal(sent.length, 0);
  });

  it('reports a failed refresh with an error status, though GitHub says 200', async () => {
    const refreshToken = await getRefreshToken();

    reply = { error: 'bad_refresh_token' };

    const response = await refresh(refreshToken);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_refresh_token' });
  });

  it('refuses anything but a refresh token', async () => {
    const response = await call('/auth', {
      method: 'POST',
      headers: { Origin: SITE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'x' }),
    });

    assert.equal(response.status, 400);
    assert.equal(sent.length, 0);
  });
});
