/**
 * Host half of the DeepSeek Web Chat bundle.
 *
 * It registers one LLM provider route backed by the consumer web chat at
 * chat.deepseek.com, so the model appears in the ordinary model selector and
 * every agent — the main loop, subagents, titles — can use it like any other
 * provider.
 *
 * No other `@deepseek-ai/*` package is imported: the kernel accepts a structural
 * adapter, and this bundle is linked from a working directory rather than
 * installed from a registry, so a bare dependency would only pin the plugin to
 * one Harness build. Schemastery is the exception — the kernel recognizes a
 * plugin's Config by the global `Symbol.for('schemastery')` marker, so the
 * schema has to come from that package rather than from a hand-written object.
 */
import z from '@deepseek-ai/schemastery';

import { DeepSeekWebAdapter, PROVIDER } from './lib/adapter.js';
import { DeepSeekWebClient, WebApiError } from './lib/client.js';
import { encodePowHeader, solveChallenge } from './lib/pow.js';
import { readBrowserTokens } from './lib/token.js';

export const name = 'deepseek-web-chat';

export const inject = ['llm'];

/**
 * The settings page renders this schema, and the Loader validates the row's
 * `config:` block against it before {@link apply} sees it.
 */
export const Config = z.object({
  tokenEnv: z
    .string()
    .default('DEEPSEEK_WEB_TOKEN')
    .description(
      'Credential name holding a chat.deepseek.com userToken. Leave empty to rely on the browser login instead.',
    ),
  readBrowserToken: z
    .boolean()
    .default(true)
    .description(
      'Read the signed-in chat.deepseek.com token from a local Chrome, Edge, Brave, or Chromium profile.',
    ),
  webSearch: z
    .boolean()
    .default(false)
    .description('Ask the web chat to search the web on every turn. Slower, and adds citations.'),
  baseURL: z
    .string()
    .default('https://chat.deepseek.com')
    .description('Site root to call. Change it only to point at a mirror or a proxy.'),
});

const DEFAULTS = {
  tokenEnv: 'DEEPSEEK_WEB_TOKEN',
  readBrowserToken: true,
  webSearch: false,
  baseURL: 'https://chat.deepseek.com',
};

/** Merge the row's configuration over the defaults. */
function normalizeConfig(config) {
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Build the shared client for one configuration snapshot.
 *
 * The token comes from the credentials store when one is configured, and from
 * the signed-in browser profile otherwise — a browser token is the normal case,
 * so it is cached briefly and re-read only after the server rejects it.
 */
function createClient(ctx, config) {
  const credentials = ctx.get('credentials');
  /** Candidates from the browser, verified once so a stale copy is never reused. */
  let browserTokens = [];
  let browserTokenAt = 0;
  let rejected = new Set();

  let client;

  const fromBrowser = async () => {
    const stillFresh = Date.now() - browserTokenAt < 60_000;
    if (!stillFresh) {
      browserTokens = await readBrowserTokens();
      browserTokenAt = Date.now();
    }
    // Newest first, but only the server can say which copy is still live: a
    // re-login leaves the previous token behind in LevelDB, so an unverified
    // "newest" pick would fail every turn after the user signs in again.
    for (const token of browserTokens) {
      if (rejected.has(token)) continue;
      try {
        await client.currentUser(token);
        return token;
      } catch (error) {
        rejected.add(token);
        if (error?.code !== 'INVALID_TOKEN' && error?.code !== 'Authorization Failed (invalid token)') throw error;
      }
    }
    return undefined;
  };

  const resolveToken = async () => {
    const stored = await credentials?.resolve(config.tokenEnv).catch(() => undefined);
    if (stored?.value) return stored.value;

    if (!config.readBrowserToken) {
      throw new WebApiError(
        `no chat.deepseek.com token: set the credential "${config.tokenEnv}" or enable readBrowserToken`,
        { code: 'MISSING_CREDENTIAL' },
      );
    }

    const found = await fromBrowser();
    if (!found) {
      throw new WebApiError(
        `no working chat.deepseek.com token: sign in to chat.deepseek.com in a local browser, or set the credential "${config.tokenEnv}"`,
        { code: 'MISSING_CREDENTIAL' },
      );
    }
    return found;
  };

  const invalidateToken = () => {
    // Drop the cached list so the next call re-reads the browser, which is where
    // a fresh sign-in lands. Known-bad tokens stay rejected, so they are not
    // re-verified on every turn.
    browserTokens = [];
    browserTokenAt = 0;
  };

  client = new DeepSeekWebClient({
    baseURL: config.baseURL,
    resolveToken,
    invalidateToken,
    pow: { solve: solveChallenge, encode: encodePowHeader },
  });

  return client;
}


export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const client = createClient(ctx, config);
  // The attachment service owns image bytes: an adapter is given durable
  // references and reads the normalized copy through this service, so it never
  // has to know where the harness stores files.
  const adapter = new DeepSeekWebAdapter({ client, config, attachments: ctx.get('attachments') });

  ctx.llm.registerAdapter([PROVIDER], adapter);

  // A harness session's server conversation is dropped with that session, so a
  // long-lived profile does not accumulate abandoned web conversations.
  ctx.on('session/disposed', (session) => {
    void adapter.release(session?.id);
  });

  ctx.logger?.info?.(`deepseek-web: registered the "${PROVIDER}" provider route`);
}

export { DeepSeekWebAdapter, DeepSeekWebClient, WebApiError };
