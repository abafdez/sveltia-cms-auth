/**
 * The OAuth endpoints of each supported provider, and how they differ. A provider’s client is
 * configured with environment variables named after it: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
 * and `GITHUB_HOSTNAME`, or the same with `GITLAB_`.
 * @type {Record<string, {
 * hostname: string, authorizePath: string, tokenPath: string, sendRedirectURI: boolean
 * }>}
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 * @see https://docs.gitlab.com/api/oauth2/
 */
const providers = {
  github: {
    hostname: 'github.com',
    authorizePath: '/login/oauth/authorize',
    tokenPath: '/login/oauth/access_token',
    // GitHub uses the callback URL registered with the app
    sendRedirectURI: false,
  },
  gitlab: {
    hostname: 'gitlab.com',
    authorizePath: '/oauth/authorize',
    tokenPath: '/oauth/token',
    // GitLab wants it with every request, and checks it against the registered one
    sendRedirectURI: true,
  },
};

/**
 * List of supported OAuth providers.
 */
const supportedProviders = Object.keys(providers);

/**
 * OAuth scopes for each provider: the scope to request when the client doesn’t ask for one, the
 * separator the provider expects between multiple scopes, and the scopes that may be requested.
 *
 * A client can ask for a narrower scope than the default — Sveltia CMS does this with its
 * `auth_scope` backend option, so a public repository doesn’t require access to a contributor’s
 * private ones — but only from this list. The endpoint is reachable by anyone, and a token minted
 * with a wider scope than the CMS needs keeps that scope for every later sign-in, so the request is
 * not taken on trust. Anything unrecognized falls back to the default, which is what an older
 * version of this worker granted regardless, so an unfamiliar client still signs in.
 *
 * GitHub’s `workflow` scope is wider than the default, so it’s only allowed when the
 * `GITHUB_ALLOW_WORKFLOW_SCOPE` environment variable is `true`: see {@link getScope}.
 * @type {Record<string, { default: string, separator: string, allowed: string[] }>}
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 * @see https://docs.gitlab.com/api/oauth2/
 */
const providerScopes = {
  github: {
    default: 'repo,user',
    separator: ',',
    allowed: ['repo', 'public_repo', 'user', 'read:user', 'user:email'],
  },
  gitlab: {
    default: 'api',
    separator: ' ',
    allowed: ['api', 'read_api', 'read_user', 'read_repository', 'write_repository'],
  },
};

/**
 * Work out the OAuth scope to request from the given provider.
 * @param {string} provider - Backend name, e.g. `github`.
 * @param {string} [requested] - The `scope` parameter from the request, if any. Scopes may be
 * separated by commas or spaces, as the two providers differ.
 * @param {{ [key: string]: string }} env - Environment variables.
 * @returns {string} Scope to request.
 */
const getScope = (provider, requested, env) => {
  const { default: fallback, separator, allowed } = providerScopes[provider];
  let scopes = (requested ?? '').split(/[\s,]+/).filter(Boolean);
  const allowWorkflow = provider === 'github' && env.GITHUB_ALLOW_WORKFLOW_SCOPE === 'true';

  // The `workflow` scope lets a token change GitHub Actions workflows in every repository the user
  // can push to, so it takes the operator’s consent as well as the site’s. Without it, the scope is
  // left out rather than the request falling back to the default, which could be wider than what
  // was asked for, e.g. `repo` instead of `public_repo`
  if (!allowWorkflow && scopes.includes('workflow')) {
    // eslint-disable-next-line no-console
    console.warn(
      `Ignoring the "workflow" scope for ${provider}; set GITHUB_ALLOW_WORKFLOW_SCOPE to "true" ` +
        'to allow it.',
    );

    scopes = scopes.filter((scope) => scope !== 'workflow');
  }

  if (!scopes.length) {
    return fallback;
  }

  if (scopes.every((scope) => allowed.includes(scope) || (allowWorkflow && scope === 'workflow'))) {
    return scopes.join(separator);
  }

  // The default is wider than what was asked for, so a client that meant to narrow the scope
  // silently doesn’t. Leave a trace for whoever is running the worker
  // eslint-disable-next-line no-console
  console.warn(
    `Ignoring the unsupported "${requested}" scope for ${provider}; requesting "${fallback}".`,
  );

  return fallback;
};

/**
 * Escape the given string for safe use in a regular expression.
 * @param {string} str - Original string.
 * @returns {string} Escaped string.
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 */
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Convert the `ALLOWED_DOMAINS` environment variable into a list of anchored regular expression
 * sources. The sources are used both here and in the client-side script embedded in
 * {@link outputHTML}, so a hostname is matched by the exact same rules on either side.
 * @param {string} [allowedDomains] - Comma-separated list of hostnames, which may contain a
 * wildcard (`*`).
 * @returns {string[]} Regular expression sources. Empty if the variable is not configured.
 */
const getDomainPatterns = (allowedDomains) =>
  (allowedDomains ?? '')
    .split(/,/)
    .map((str) => str.trim())
    .filter(Boolean)
    // Escape the input, then replace a wildcard for regex
    .map((str) => `^${escapeRegExp(str).replaceAll('\\*', '.+')}$`);

/**
 * Serialize the given value for safe embedding in an inline `<script>` block.
 * @param {string | boolean | string[]} value - Value to be serialized.
 * @returns {string} JavaScript literal.
 */
const serialize = (value) => JSON.stringify(value ?? null).replaceAll('<', '\\u003c');

/**
 * Get the OAuth client configured for the given provider.
 * @param {string} provider - Backend name, e.g. `github`.
 * @param {{ [key: string]: string }} env - Environment variables.
 * @param {string} origin - The worker’s own origin, for the redirect URI.
 * @returns {{ clientId: string, clientSecret: string, authorizeURL: string, tokenURL: string,
 * redirectURI?: string, pkce: boolean } | undefined} Client, or `undefined` if its ID or secret is
 * not configured.
 */
const getClient = (provider, env, origin) => {
  const prefix = provider.toUpperCase();

  const {
    hostname: defaultHostname,
    authorizePath,
    tokenPath,
    sendRedirectURI,
  } = providers[provider];

  const hostname = env[`${prefix}_HOSTNAME`] || defaultHostname;
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    return undefined;
  }

  return {
    clientId,
    clientSecret,
    authorizeURL: `https://${hostname}${authorizePath}`,
    tokenURL: `https://${hostname}${tokenPath}`,
    redirectURI: sendRedirectURI ? `${origin}/callback` : undefined,
    // GitHub Enterprise Server doesn’t support PKCE yet, and may not ignore its parameters
    pkce: provider !== 'github' || hostname === 'github.com',
  };
};

/**
 * Generate a random string of hexadecimal digits.
 * @param {number} bytes - Number of random bytes, each of which becomes two digits.
 * @returns {string} Random string.
 */
const getRandomHex = (bytes) =>
  [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/**
 * Encode bytes as base64url, without padding.
 * @param {Uint8Array} bytes - Bytes.
 * @returns {string} Encoded string.
 */
const toBase64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/**
 * Decode a base64url string.
 * @param {string} str - Encoded string.
 * @returns {Uint8Array} Bytes.
 * @throws {Error} When the string is not valid base64url.
 */
const fromBase64url = (str) =>
  Uint8Array.from(atob(str.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
    char.charCodeAt(0),
  );

/**
 * Derive the PKCE code challenge from a code verifier, with the `S256` method.
 * @param {string} verifier - Code verifier.
 * @returns {Promise<string>} Base64url-encoded SHA-256 hash of the verifier.
 * @see https://datatracker.ietf.org/doc/html/rfc7636#section-4.2
 */
const getCodeChallenge = async (verifier) => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );

  return toBase64url(new Uint8Array(digest));
};

/**
 * A response from a provider’s token endpoint.
 * @typedef {object} TokenResponse
 * @property {string} [access_token] - Access token.
 * @property {string} [refresh_token] - Refresh token, if the provider issued one.
 * @property {string} [token_type] - Token type, e.g. `bearer`.
 * @property {number} [expires_in] - Seconds until the access token expires, if it does.
 * @property {string} [error] - Error code, if no token was issued.
 */

/**
 * Request an access token from the provider, with an authorization code or a refresh token.
 * @param {string} tokenURL - The provider’s token endpoint.
 * @param {Record<string, string>} body - Request parameters.
 * @returns {Promise<{ result?: TokenResponse, errorCode?: string }>} The provider’s response,
 * which may itself carry an `error`, or the reason there is none.
 */
const requestToken = async (tokenURL, body) => {
  let response;

  try {
    response = await fetch(tokenURL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { errorCode: 'TOKEN_REQUEST_FAILED' };
  }

  try {
    return { result: await response.json() };
  } catch {
    return { errorCode: 'MALFORMED_RESPONSE' };
  }
};

/**
 * How long after signing in a refresh token can still be used, in seconds. After that, the user
 * signs in again; their last access token still lasts its own lifetime, e.g. 8 hours for GitHub.
 *
 * A refresh token is kept in the browser, where malicious script or a browser extension could steal
 * it, and the worker, which adds the client secret, would renew it for anyone who sends it. GitHub
 * keeps one valid for 6 months; this keeps what a stolen one is worth to a day, like the limit
 * GitHub plans for browser apps that refresh tokens on their own.
 * @see https://github.com/github/roadmap/issues/1153
 */
const SESSION_MAX_AGE = 24 * 60 * 60;

/**
 * Derive the key that seals refresh tokens from the client secret, so the worker needs no key of
 * its own, and generating a new client secret signs everyone out.
 * @param {string} provider - Backend name, e.g. `github`.
 * @param {string} clientSecret - OAuth client secret.
 * @returns {Promise<CryptoKey>} AES-GCM key.
 */
const getSealingKey = async (provider, clientSecret) => {
  const encoder = new TextEncoder();

  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encoder.encode(`sveltia-cms-auth:refresh-token:${provider}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

/**
 * Seal a refresh token before it goes to the browser: encrypt it, along with when the user signed
 * in, so the worker can refuse it after {@link SESSION_MAX_AGE}, and turn away anything it didn’t
 * issue without asking the provider. The result starts with the provider, so the worker knows which
 * one to send it to; the CMS treats it as opaque.
 * @param {object} args - Arguments.
 * @param {string} args.provider - Backend name, e.g. `github`.
 * @param {string} args.clientSecret - OAuth client secret.
 * @param {string} [args.refreshToken] - The provider’s refresh token, if it issued one.
 * @param {number} args.signedInAt - When the user signed in, in seconds since the epoch.
 * @returns {Promise<string | undefined>} Sealed refresh token.
 */
const sealRefreshToken = async ({ provider, clientSecret, refreshToken, signedInAt }) => {
  if (!refreshToken) {
    return undefined;
  }

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await getSealingKey(provider, clientSecret),
    new TextEncoder().encode(JSON.stringify({ token: refreshToken, signedInAt })),
  );

  return `${provider}:${toBase64url(new Uint8Array([...iv, ...new Uint8Array(sealed)]))}`;
};

/**
 * Open a refresh token sealed by {@link sealRefreshToken}.
 * @param {string} provider - Backend name, e.g. `github`.
 * @param {string} clientSecret - OAuth client secret.
 * @param {string} sealed - Sealed refresh token, without the provider.
 * @returns {Promise<{ token: string, signedInAt: number } | undefined>} The provider’s refresh
 * token and when the user signed in, or `undefined` if it wasn’t sealed by this worker with this
 * secret, or was tampered with.
 */
const openRefreshToken = async (provider, clientSecret, sealed) => {
  try {
    const bytes = fromBase64url(sealed);

    const data = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await getSealingKey(provider, clientSecret),
      bytes.slice(12),
    );

    const { token, signedInAt } = JSON.parse(new TextDecoder().decode(data));

    if (typeof token === 'string' && Number.isInteger(signedInAt)) {
      return { token, signedInAt };
    }
  } catch {
    //
  }

  return undefined;
};

/**
 * The current time, in seconds since the epoch.
 * @returns {number} Time.
 */
const now = () => Math.floor(Date.now() / 1000);

/**
 * Whether the given origin is a page on one of the `ALLOWED_DOMAINS`.
 * @param {string | null} origin - Origin, e.g. `https://www.example.com`.
 * @param {string[]} domainPatterns - Patterns from {@link getDomainPatterns}.
 * @returns {boolean} Result.
 */
const isAllowedOrigin = (origin, domainPatterns) => {
  try {
    const { hostname } = new URL(origin ?? '');

    return domainPatterns.some((pattern) => new RegExp(pattern).test(hostname));
  } catch {
    return false;
  }
};

/**
 * The error shown when `ALLOWED_DOMAINS` isn’t set: without it, any site could open the sign-in
 * popup and receive a token, which GitHub hands out without asking once a user has authorized the
 * app, so the worker gives none.
 */
const domainsNotConfigured = {
  error: 'ALLOWED_DOMAINS is not configured on the authenticator, so it gives no tokens.',
  errorCode: 'MISCONFIGURED_DOMAINS',
};

/**
 * Output HTML response that communicates with the window opener.
 * @param {object} args - Options.
 * @param {string} [args.provider] - Backend name, e,g. `github`.
 * @param {string} [args.token] - OAuth token.
 * @param {string} [args.refreshToken] - OAuth refresh token, if the provider issued one: GitHub
 * does for a GitHub App with expiring user tokens, and GitLab always does.
 * @param {string} [args.error] - Error message when an OAuth token is not available.
 * @param {string} [args.errorCode] - Error code to be used to localize the error message in
 * Sveltia CMS.
 * @param {{ [key: string]: string }} [args.env] - Environment variables.
 * @returns {Response} Response with HTML.
 */
const outputHTML = ({ provider = 'unknown', token, refreshToken, error, errorCode, env = {} }) => {
  const state = error ? 'error' : 'success';
  const content = error ? { provider, error, errorCode } : { provider, token, refreshToken };
  // Only this page’s own script may run; the page carries tokens
  const nonce = getRandomHex(16);

  return new Response(
    `
      <!doctype html><html><body><script nonce="${nonce}">
        (() => {
          const trustedPatterns = ${serialize(getDomainPatterns(env.ALLOWED_DOMAINS))};
          const hasToken = ${serialize(!!token)};

          const isTrusted = (origin) => {
            try {
              const { hostname } = new URL(origin);

              return trustedPatterns.some((pattern) => new RegExp(pattern).test(hostname));
            } catch {
              return false;
            }
          };

          window.addEventListener('message', ({ data, origin }) => {
            if (data !== 'authorizing:${provider}') {
              return;
            }

            // Unlike the site_id parameter, which the caller supplies, the origin of a message
            // event is set by the browser and cannot be forged by the sender, so it’s the only
            // reliable indication of who opened this popup. An error carries no secret, so it’s
            // always passed through to keep the sign-in screen informative. With no patterns,
            // nobody is trusted
            if (hasToken && !isTrusted(origin)) {
              return;
            }

            window.opener?.postMessage(
              ${serialize(`authorization:${provider}:${state}:${JSON.stringify(content)}`)},
              origin
            );
          });
          window.opener?.postMessage('authorizing:${provider}', '*');
        })();
      </script></body></html>
    `,
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Content-Security-Policy':
          `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; ` +
          `form-action 'none'; frame-ancestors 'none'`,
        // Tokens mustn’t stay in the browser’s cache, nor the code in the URL reach another site
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        // Delete CSRF token
        'Set-Cookie': `csrf-token=deleted; HttpOnly; Max-Age=0; Path=/; SameSite=Lax; Secure`,
      },
    },
  );
};

/**
 * Handle the `auth` method, which is the first request in the authorization flow.
 * @param {Request} request - HTTP request.
 * @param {{ [key: string]: string }} env - Environment variables.
 * @returns {Promise<Response>} HTTP response.
 */
const handleAuth = async (request, env) => {
  const { url } = request;
  const { origin, searchParams } = new URL(url);
  const { provider, site_id: domain, scope: requestedScope } = Object.fromEntries(searchParams);

  if (!provider || !supportedProviders.includes(provider)) {
    return outputHTML({
      env,
      error: 'Your Git backend is not supported by the authenticator.',
      errorCode: 'UNSUPPORTED_BACKEND',
    });
  }

  const scope = getScope(provider, requestedScope, env);
  const domainPatterns = getDomainPatterns(env.ALLOWED_DOMAINS);

  if (!domainPatterns.length) {
    return outputHTML({ env, provider, ...domainsNotConfigured });
  }

  // Check if the domain is whitelisted. It’s the caller’s word for it, so this only turns other
  // sites away early; the popup checks who it’s really talking to before handing over a token
  if (!domainPatterns.some((pattern) => new RegExp(pattern).test(domain ?? ''))) {
    return outputHTML({
      env,
      provider,
      error: 'Your domain is not allowed to use the authenticator.',
      errorCode: 'UNSUPPORTED_DOMAIN',
    });
  }

  const client = getClient(provider, env, origin);

  if (!client) {
    return outputHTML({
      env,
      provider,
      error: 'OAuth app client ID or secret is not configured.',
      errorCode: 'MISCONFIGURED_CLIENT',
    });
  }

  // Generate a random string for CSRF protection
  const csrfToken = globalThis.crypto.randomUUID().replaceAll('-', '');
  // And a PKCE code verifier: the code GitHub or GitLab sends back can then only be exchanged for a
  // token along with it, so a code stolen from someone else’s sign-in, and slipped into this one,
  // is useless. It stays in the cookie below, never in a URL
  const codeVerifier = client.pkce ? getRandomHex(32) : '';

  const params = new URLSearchParams({
    client_id: client.clientId,
    scope,
    state: csrfToken,
    ...(client.redirectURI && { redirect_uri: client.redirectURI, response_type: 'code' }),
    ...(codeVerifier && {
      code_challenge: await getCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    }),
  });

  const authURL = `${client.authorizeURL}?${params.toString()}`;

  // Redirect to the authorization server
  return new Response('', {
    status: 302,
    headers: {
      Location: authURL,
      // Cookie expires in 10 minutes; Use `SameSite=Lax` to make sure the cookie is sent by the
      // browser after redirect
      'Set-Cookie':
        `csrf-token=${provider}_${csrfToken}${codeVerifier ? `_${codeVerifier}` : ''}; ` +
        `HttpOnly; Path=/; Max-Age=600; SameSite=Lax; Secure`,
    },
  });
};

/**
 * Handle the `callback` method, which is the second request in the authorization flow.
 * @param {Request} request - HTTP request.
 * @param {{ [key: string]: string }} env - Environment variables.
 * @returns {Promise<Response>} HTTP response.
 */
const handleCallback = async (request, env) => {
  const { url, headers } = request;
  const { origin, searchParams } = new URL(url);
  const { code, state } = Object.fromEntries(searchParams);

  const [, provider, csrfToken, codeVerifier] =
    headers.get('Cookie')?.match(/\bcsrf-token=([a-z-]+?)_([0-9a-f]{32})(?:_([0-9a-f]{64}))?\b/) ??
    [];

  if (!provider || !supportedProviders.includes(provider)) {
    return outputHTML({
      env,
      error: 'Your Git backend is not supported by the authenticator.',
      errorCode: 'UNSUPPORTED_BACKEND',
    });
  }

  if (!code || !state) {
    return outputHTML({
      env,
      provider,
      error: 'Failed to receive an authorization code. Please try again later.',
      errorCode: 'AUTH_CODE_REQUEST_FAILED',
    });
  }

  if (!csrfToken || state !== csrfToken) {
    return outputHTML({
      env,
      provider,
      error: 'Potential CSRF attack detected. Authentication flow aborted.',
      errorCode: 'CSRF_DETECTED',
    });
  }

  if (!getDomainPatterns(env.ALLOWED_DOMAINS).length) {
    return outputHTML({ env, provider, ...domainsNotConfigured });
  }

  const client = getClient(provider, env, origin);

  if (!client) {
    return outputHTML({
      env,
      provider,
      error: 'OAuth app client ID or secret is not configured.',
      errorCode: 'MISCONFIGURED_CLIENT',
    });
  }

  const { result, errorCode } = await requestToken(client.tokenURL, {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    ...(client.redirectURI && {
      grant_type: 'authorization_code',
      redirect_uri: client.redirectURI,
    }),
    ...(codeVerifier && { code_verifier: codeVerifier }),
  });

  if (errorCode) {
    return outputHTML({
      env,
      provider,
      error:
        errorCode === 'MALFORMED_RESPONSE'
          ? 'Server responded with malformed data. Please try again later.'
          : 'Failed to request an access token. Please try again later.',
      errorCode,
    });
  }

  const { access_token: token, refresh_token: refreshToken, error } = result ?? {};

  return outputHTML({
    env,
    provider,
    token,
    refreshToken: await sealRefreshToken({
      provider,
      clientSecret: client.clientSecret,
      refreshToken,
      signedInAt: now(),
    }),
    error,
  });
};

/**
 * Send a JSON response to the token refresh request.
 * @param {TokenResponse} body - Response body.
 * @param {number} status - HTTP status.
 * @param {Record<string, string>} [headers] - CORS headers.
 * @returns {Response} HTTP response.
 */
const outputJSON = (body, status, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

/**
 * Handle a token refresh request. An access token from GitLab, or from a GitHub App with expiring
 * user tokens, lasts only a few hours; Sveltia CMS then exchanges the refresh token it got along
 * with it for a new one, without the user signing in again. That needs the client secret, so the
 * request comes here, like the sign-in, and the worker adds the secret.
 *
 * Unlike the sign-in, it’s an API request from the CMS page itself, so it’s answered with CORS
 * headers, only for a page served from one of the `ALLOWED_DOMAINS`.
 * @param {Request} request - HTTP request: a `POST` with `grant_type` and `refresh_token` in a JSON
 * body, or its `OPTIONS` preflight.
 * @param {{ [key: string]: string }} env - Environment variables.
 * @returns {Promise<Response>} HTTP response, in the format of the provider’s token endpoint.
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
 * @see https://docs.gitlab.com/api/oauth2/
 */
const handleRefresh = async (request, env) => {
  const { method, url, headers } = request;
  const origin = headers.get('Origin');

  // Another site’s page can’t send a refresh token here, nor read the answer: browsers send the
  // real `Origin`. A script outside a browser can claim any origin, though, which is why a refresh
  // token is sealed, and only good for a day after signing in
  if (!isAllowedOrigin(origin, getDomainPatterns(env.ALLOWED_DOMAINS))) {
    return outputJSON({ error: 'access_denied' }, 403);
  }

  const cors = {
    'Access-Control-Allow-Origin': /** @type {string} */ (origin),
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  /** @type {{ grant_type?: unknown, refresh_token?: unknown } | undefined} */
  let body;

  try {
    body = await request.json();
  } catch {
    //
  }

  if (body?.grant_type !== 'refresh_token' || typeof body.refresh_token !== 'string') {
    return outputJSON({ error: 'unsupported_grant_type' }, 400, cors);
  }

  // The provider added by `sealRefreshToken`
  const [, provider, sealed] = body.refresh_token.match(/^([a-z-]+):([\w-]+)$/) ?? [];

  if (!provider || !supportedProviders.includes(provider)) {
    return outputJSON({ error: 'invalid_grant' }, 400, cors);
  }

  const client = getClient(provider, env, new URL(url).origin);

  if (!client) {
    return outputJSON({ error: 'invalid_client' }, 500, cors);
  }

  // Turned away without asking the provider: not sealed by this worker, or too old
  const opened = await openRefreshToken(provider, client.clientSecret, sealed);

  if (!opened || now() - opened.signedInAt > SESSION_MAX_AGE) {
    return outputJSON({ error: 'invalid_grant' }, 400, cors);
  }

  const { result, errorCode } = await requestToken(client.tokenURL, {
    grant_type: 'refresh_token',
    refresh_token: opened.token,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    ...(client.redirectURI && { redirect_uri: client.redirectURI }),
  });

  // GitHub reports a failure, such as an expired refresh token, with `200 OK` and an `error`
  if (errorCode || typeof result?.access_token !== 'string') {
    return outputJSON({ error: result?.error ?? 'server_error' }, 400, cors);
  }

  return outputJSON(
    {
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      // Both GitHub and GitLab issue a new refresh token each time, and the old one stops working.
      // It’s sealed with the original sign-in time, so the session doesn’t get any longer
      refresh_token: await sealRefreshToken({
        provider,
        clientSecret: client.clientSecret,
        refreshToken: result.refresh_token,
        signedInAt: opened.signedInAt,
      }),
    },
    200,
    cors,
  );
};

export default {
  /**
   * The main request handler.
   * @param {Request} request - HTTP request.
   * @param {{ [key: string]: string }} env - Environment variables.
   * @returns {Promise<Response>} HTTP response.
   * @see https://developers.cloudflare.com/workers/runtime-apis/fetch/
   * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
   * @see https://docs.gitlab.com/ee/api/oauth2.html#authorization-code-flow
   */
  async fetch(request, env) {
    const { method, url } = request;
    const { pathname } = new URL(url);

    if (method === 'GET' && ['/auth', '/oauth/authorize'].includes(pathname)) {
      return handleAuth(request, env);
    }

    if (method === 'GET' && ['/callback', '/oauth/redirect'].includes(pathname)) {
      return handleCallback(request, env);
    }

    // Where Sveltia CMS sends a refresh token: its sign-in URL with `/authorize` replaced, which
    // leaves the default `/auth` as it is
    if (
      ['POST', 'OPTIONS'].includes(method) &&
      ['/auth', '/oauth/access_token', '/oauth/token'].includes(pathname)
    ) {
      return handleRefresh(request, env);
    }

    return new Response('', { status: 404 });
  },
};
