/**
 * Minimal client for the consumer web chat at chat.deepseek.com.
 *
 * Two things make this endpoint usable from a process instead of a browser:
 * the `userToken` that the page keeps in Local Storage, and the
 * `DeepSeekHashV1` proof-of-work header each completion must carry. Both are
 * supplied here; everything else is ordinary JSON and server-sent events.
 */

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** A failure the caller can classify without parsing text. */
export class WebApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WebApiError';
    this.code = options.code;
    this.status = options.status;
  }
}

/**
 * A `code: 0` envelope is not always a success. The site puts business-level
 * refusals in `data.biz_code` / `data.biz_msg` and leaves `msg` empty, so a
 * client that only reads `msg` reports the useless "refused: 0".
 *
 * @returns a stable code and a human message, or null when the envelope is fine.
 */
function refusal(parsed) {
  const bizCode = parsed?.data?.biz_code;
  if (bizCode === undefined || bizCode === null || bizCode === 0) return null;
  const code = bizCode === 9 ? 'INVALID_REF_FILE' : `BIZ_${bizCode}`;
  return { code, message: parsed.data?.biz_msg || `business code ${bizCode}` };
}

/** A delay that honours cancellation, so a cancelled turn does not wait it out. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Split an SSE body into lines, honouring multi-byte characters across chunks. */
async function* lines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/**
 * Turn the server's frame vocabulary into semantic events.
 *
 * The page receives one full snapshot first, then `p`/`v` patches that either
 * append to the fragment currently at `-1` or push a new fragment. Content is
 * routed by the fragment type it belongs to, which is what separates the
 * thinking transcript from the visible answer.
 */
export async function* readFrames(body) {
  let currentType = null;
  for await (const raw of lines(body)) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith('event:')) continue;
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;

    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }

    // The opening frame names the two message ids the conversation advances by.
    if (frame.response_message_id !== undefined) {
      yield { kind: 'ready', responseMessageId: frame.response_message_id };
      continue;
    }

    if (frame.v && typeof frame.v === 'object' && frame.v.response) {
      const response = frame.v.response;
      yield { kind: 'snapshot', response };
      const fragments = response.fragments ?? [];
      if (fragments.length > 0) currentType = fragments.at(-1).type;
      continue;
    }

    if (typeof frame.p === 'string' && frame.p === 'response/fragments' && Array.isArray(frame.v)) {
      for (const fragment of frame.v) {
        currentType = fragment.type;
        yield { kind: 'fragment', fragment };
      }
      continue;
    }

    if (typeof frame.p === 'string' && frame.p.endsWith('/results') && Array.isArray(frame.v)) {
      yield { kind: 'results', results: frame.v };
      continue;
    }

    if (typeof frame.p === 'string' && frame.p === 'response' && Array.isArray(frame.v)) {
      for (const item of frame.v) {
        if (item.p === 'accumulated_token_usage' && typeof item.v === 'number') {
          yield { kind: 'usage', tokens: item.v };
        }
      }
      continue;
    }

    if (typeof frame.p === 'string' && frame.p === 'response/status') {
      if (frame.v === 'FINISHED') yield { kind: 'finished' };
      continue;
    }

    // A bare `{v: "text"}` or a `response/fragments/-1/content` patch appends
    // to whichever fragment is current.
    const isBareText = typeof frame.v === 'string' && frame.p === undefined;
    const isContentPatch =
      typeof frame.v === 'string' &&
      typeof frame.p === 'string' &&
      frame.p.startsWith('response/fragments/-1/content');
    if (isBareText || isContentPatch) {
      // A bare append can arrive before any fragment named its type — the
      // opening snapshot often carries no fragments at all. Such text is the
      // visible answer, so an unknown type must default to RESPONSE; treating it
      // as "untyped, therefore ignorable" silently drops whole answers.
      yield { kind: 'content', fragmentType: currentType ?? 'RESPONSE', text: frame.v };
    }
  }
}

/** The client itself: token handling, PoW, session lifecycle, and streaming. */
export class DeepSeekWebClient {
  #baseURL;
  #userAgent;
  #resolveToken;
  #invalidateToken;
  #pow;

  constructor(options) {
    this.#baseURL = (options.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.#resolveToken = options.resolveToken;
    this.#invalidateToken = options.invalidateToken ?? (() => {});
    this.#pow = options.pow;
  }

  /** Resolve the token every call is authorized with. */
  async resolveToken() {
    return this.#resolveToken();
  }

  /** Request headers shared by every call. */
  #headers(token, extra = {}) {
    return {
      'user-agent': this.#userAgent,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: '*/*',
      origin: this.#baseURL,
      referer: `${this.#baseURL}/`,
      ...extra,
    };
  }

  /** Read the server's answer envelope, or throw with its code. */
  async #envelope(response, label) {
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WebApiError(
        `${label} returned a non-JSON reply (HTTP ${response.status})`,
        { code: 'TRANSPORT', status: response.status },
      );
    }
    if (parsed.code !== 0) {
      // `INVALID_TOKEN` is the one answer that says the cached token is dead, so
      // the caller must stop reusing it — otherwise every later turn repeats the
      // same rejection until the process restarts.
      const invalid = parsed.code === 40003;
      if (invalid) this.#invalidateToken();
      throw new WebApiError(`${label} failed: ${parsed.msg || parsed.code}`, {
        code: invalid ? 'INVALID_TOKEN' : parsed.msg || `CODE_${parsed.code}`,
        status: response.status,
        invalidToken: invalid,
      });
    }
    const refused = refusal(parsed);
    if (refused) {
      throw new WebApiError(`${label} failed: ${refused.message}`, {
        code: refused.code,
        status: response.status,
      });
    }
    return parsed.data?.biz_data ?? {};
  }

  /** Prove work for one target path. */
  async #powHeader(targetPath, token) {
    const response = await fetch(`${this.#baseURL}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: this.#headers(token),
      body: JSON.stringify({ target_path: targetPath }),
    });
    const data = await this.#envelope(response, 'the proof-of-work challenge request');
    const challenge = data.challenge;
    if (!challenge) throw new WebApiError('the server returned no proof-of-work challenge', { code: 'PROTOCOL' });
    const answer = await this.#pow.solve(challenge);
    return this.#pow.encode(challenge, answer);
  }

  /** Confirm the token still belongs to a signed-in account. */
  async currentUser(token) {
    const response = await fetch(`${this.#baseURL}/api/v0/users/current`, {
      headers: this.#headers(token),
    });
    const data = await this.#envelope(response, 'the account check');
    return { id: data.id, name: data.id_profile?.name };
  }

  /** Open a server-side conversation. */
  async createSession(token) {
    const response = await fetch(`${this.#baseURL}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: this.#headers(token),
      body: JSON.stringify({ character_id: null }),
    });
    const data = await this.#envelope(response, 'the conversation creation request');
    const id = data.chat_session?.id;
    if (!id) throw new WebApiError('the server returned no conversation id', { code: 'PROTOCOL' });
    return id;
  }

  /**
   * Upload one attachment and return the id the completion call refers to.
   *
   * This is a multipart form, so the shared JSON `content-type` is deliberately
   * not sent: the browser lets the boundary header supply it, and a hard-coded
   * `application/json` makes the server read the body as a broken JSON document.
   * The upload carries its own proof of work for its own target path.
   *
   * @param options.token the signed-in web token.
   * @param options.data the file bytes.
   * @param options.name the file name shown in the conversation.
   * @param options.mediaType the declared MIME type.
   * @returns the server-side file id.
   */
  async uploadFile({ token, data, name, mediaType }) {
    const pow = await this.#powHeader('/api/v0/file/upload_file', token);
    const form = new FormData();
    form.append('file', new Blob([data], { type: mediaType }), name);

    const response = await fetch(`${this.#baseURL}/api/v0/file/upload_file`, {
      method: 'POST',
      headers: {
        'user-agent': this.#userAgent,
        authorization: `Bearer ${token}`,
        accept: '*/*',
        origin: this.#baseURL,
        referer: `${this.#baseURL}/`,
        'x-ds-pow-response': pow,
      },
      body: form,
    });

    const uploaded = await this.#envelope(response, 'the file upload');
    if (!uploaded.id) throw new WebApiError('the server returned no file id', { code: 'PROTOCOL' });
    return uploaded.id;
  }

  /**
   * Wait until the server has finished parsing an uploaded file.
   *
   * A completion that names a file still being parsed is rejected, and an image
   * is normally ready within a second or two, so this polls briefly rather than
   * failing the turn.
   *
   * @param fileId the id {@link uploadFile} returned.
   * @param token the signed-in web token.
   * @param options.signal cancellation.
   * @param options.timeoutMs how long to wait before giving up.
   * @returns the file record, whatever state it settled in.
   */
  async waitForFile(fileId, token, options = {}) {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const deadline = Date.now() + timeoutMs;
    let last = null;

    for (;;) {
      options.signal?.throwIfAborted();
      const response = await fetch(
        `${this.#baseURL}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        { headers: this.#headers(token), signal: options.signal },
      );
      const data = await this.#envelope(response, 'the file status request');
      const file = (data.files ?? []).find((entry) => entry.id === fileId) ?? null;
      if (file) last = file;
      if (file && file.status !== 'PENDING' && file.status !== 'PARSING') return file;
      if (Date.now() >= deadline) return last ?? { id: fileId, status: 'TIMEOUT' };
      await sleep(700, options.signal);
    }
  }

  /** Discard a server-side conversation; best effort, so failures are ignored. */
  async deleteSession(sessionId, token) {
    try {
      await fetch(`${this.#baseURL}/api/v0/chat_session/delete`, {
        method: 'POST',
        headers: this.#headers(token),
        body: JSON.stringify({ chat_session_id: sessionId }),
      });
    } catch {
      // A conversation left behind is cosmetic; the turn already settled.
    }
  }

  /**
   * Stream one turn.
   * @param options.sessionId server conversation.
   * @param options.parentMessageId the assistant message this one replies to, or null to start.
   * @param options.prompt the text to send.
   * @param options.refFileIds uploaded files this turn refers to, in order.
   * @param options.thinking enable the deep-think pass.
   * @param options.search enable web search.
   * @param options.signal cancellation.
   * @param options.token reuse the login the caller uploaded files under.
   */
  async *completion(options) {
    // The caller may pin the token so the upload and the completion are
    // authorized by the same login. Resolving twice lets a re-login land
    // between them, which makes the just-uploaded file id unrecognizable.
    const token = options.token ?? await this.#resolveToken();
    const pow = await this.#powHeader('/api/v0/chat/completion', token);

    const response = await fetch(`${this.#baseURL}/api/v0/chat/completion`, {
      method: 'POST',
      headers: this.#headers(token, { 'x-ds-pow-response': pow, accept: 'text/event-stream' }),
      body: JSON.stringify({
        chat_session_id: options.sessionId,
        parent_message_id: options.parentMessageId ?? null,
        prompt: options.prompt,
        ref_file_ids: options.refFileIds ?? [],
        thinking_enabled: Boolean(options.thinking),
        search_enabled: Boolean(options.search),
      }),
      signal: options.signal,
    });

    if (response.status !== 200) {
      const text = await response.text();
      throw new WebApiError(`the completion request failed (HTTP ${response.status}): ${text.slice(0, 300)}`, {
        code: 'HTTP',
        status: response.status,
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('event-stream')) {
      // A JSON body here is the server refusing the turn, not a stream.
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new WebApiError(`the completion request returned an unreadable reply: ${text.slice(0, 300)}`, {
          code: 'PROTOCOL',
        });
      }
      if (parsed.code === 40003) this.#invalidateToken();
      if (parsed.code !== 0) {
        throw new WebApiError(`the completion request was refused: ${parsed.msg || parsed.code}`, {
          code: parsed.msg || `CODE_${parsed.code}`,
        });
      }
      const refused = refusal(parsed);
      if (refused) {
        throw new WebApiError(`the completion request was refused: ${refused.message}`, {
          code: refused.code,
        });
      }
      throw new WebApiError(`the completion request returned an unreadable reply: ${text.slice(0, 300)}`, {
        code: 'PROTOCOL',
      });
    }

    yield* readFrames(response.body);
  }
}
