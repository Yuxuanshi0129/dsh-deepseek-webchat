/**
 * The LLM adapter: one provider route that speaks the consumer web chat.
 *
 * The endpoint streams the answer token by token, so reasoning deltas pass
 * straight through. Visible text is accumulated and emitted once at the end,
 * because a tool call is requested in text and only a complete reply can be
 * parsed reliably — streaming a partial `<tool_call>` block would show the
 * user fragments of JSON.
 *
 * The class is a structural `LlmAdapter`: the kernel calls these methods and
 * never checks `instanceof`, so importing the package would only pin this
 * plugin to one Harness version.
 */
import { WebApiError } from './client.js';
import { buildPrompt, canContinue, collectImages, parseReply, transcriptDigest } from './prompt.js';

const PROVIDER = 'deepseek-web';
const MODEL_ID = 'deepseek-web';
const CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

export class DeepSeekWebAdapter {
  #client;
  #config;
  #attachments;
  #sessions = new Map();
  /**
   * Uploaded file ids, keyed by attachment id.
   *
   * The web chat addresses files by a server id, and an attachment's bytes never
   * change, so one upload serves every later turn that mentions the same image.
   * Without this a long conversation would re-upload on each step.
   */
  #uploads = new Map();

  constructor({ client, config, attachments }) {
    this.#client = client;
    this.#config = config;
    this.#attachments = attachments;
  }

  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek Web' };
  }

  providerRetryPolicy() {
    // The account is throttled per conversation, so a short bounded retry is
    // enough and a long one only delays the visible failure. `EMPTY_RESPONSE` is
    // retryable: the page occasionally finishes with no content at all (a
    // transient server hiccup, not a refusal), and one more attempt usually
    // answers normally.
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'TRANSPORT', 'TIMEOUT', 'SERVER', 'EMPTY_RESPONSE', 'INVALID_REF_FILE'],
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      jitterRatio: 0.2,
    };
  }

  async listModels() {
    return [
      {
        provider: PROVIDER,
        id: MODEL_ID,
        name: 'DeepSeek Web Chat',
        description: 'Runs on the signed-in chat.deepseek.com account; supports deep thinking, web search, and images.',
        inputModalities: ['text', 'image'],
      },
    ];
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: 'DeepSeek Web Chat',
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      inputModalities: ['text', 'image'],
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off', description: 'Answer directly, without the deep-think pass.' },
          { id: 'high', name: 'Deep think', description: 'Let the web page reason before answering.' },
        ],
        defaultEffort: 'off',
      },
    };
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /**
   * Resolve or open the server conversation backing one harness session.
   * @param sessionId the harness session identity.
   * @param token the current web token.
   */
  async #serverSession(sessionId, token) {
    const key = sessionId ?? 'anonymous';
    let entry = this.#sessions.get(key);
    if (!entry) {
      entry = {
        id: await this.#client.createSession(token),
        lastMessageId: null,
        turns: 0,
        prefixHash: null,
      };
      this.#sessions.set(key, entry);
    }
    return entry;
  }

  /**
   * Upload the images this turn mentions and return their server ids.
   *
   * The endpoint has no inline image field: an image is a file the account owns,
   * referenced by id, so each one is uploaded first and only its id is sent. The
   * id is cached per attachment because the bytes are immutable — re-uploading
   * the same screenshot on every step of a tool loop would be pure waste.
   *
   * The cache is keyed by attachment id only: a browser re-login rotates the
   * account's session token, and the site then replies `invalid ref file id`
   * for ids uploaded under the old token. {@link stream} notices that refusal,
   * clears the cache, and calls this again to upload fresh copies.
   *
   * @param images durable references from the prompt being built.
   * @param token the signed-in web token.
   * @param signal cancellation.
   * @returns one server file id per reference, in the same order.
   */
  async #uploadImages(images, token, signal) {
    if (images.length === 0) return [];

    const attachments = this.#attachments;
    if (!attachments?.readImage) {
      throw new WebApiError(
        'this image cannot be sent: the attachment service is unavailable, so its bytes cannot be read',
        { code: 'UNSUPPORTED_CONTENT' },
      );
    }

    const ids = [];
    for (const ref of images) {
      signal?.throwIfAborted();

      const cached = this.#uploads.get(String(ref.attachmentId));
      if (cached) {
        ids.push(cached);
        continue;
      }

      const stored = await attachments.readImage(ref, signal);
      const data = stored?.data ?? stored;
      const mediaType = ref.mediaType ?? 'image/png';
      const name = ref.name ?? `image.${extensionOf(mediaType)}`;

      const fileId = await this.#client.uploadFile({ token, data, name, mediaType });
      // A completion that names a file still being parsed is refused, and an
      // image is usually ready in a second or two.
      const settled = await this.#client.waitForFile(fileId, token, { signal });
      if (settled?.status && settled.status !== 'SUCCESS') {
        throw new WebApiError(
          `the image upload did not finish parsing (status ${settled.status}${settled.error_code ? `, code ${settled.error_code}` : ''})`,
          { code: 'UPLOAD_FAILED' },
        );
      }

      this.#uploads.set(String(ref.attachmentId), fileId);
      ids.push(fileId);
    }
    return ids;
  }

  async *stream(options) {
    const token = await this.#client.resolveToken();
    let entry = await this.#serverSession(options.sessionId, token);

    // The server owns the transcript, so a later turn only needs its new tail —
    // unless this is the first turn, or the transcript no longer extends what
    // the server answered, in which case the whole conversation is replayed.
    const { continuation } = canContinue({
      messages: options.messages,
      provider: PROVIDER,
      prefixHash: entry.prefixHash,
    });
    if (!continuation && entry.turns > 0) {
      // The server's copy cannot be reused; start a clean conversation so the
      // replayed transcript is the only history in play.
      const key = options.sessionId ?? 'anonymous';
      this.#sessions.delete(key);
      void this.#client.deleteSession(entry.id, token);
      entry = {
        id: await this.#client.createSession(token),
        lastMessageId: null,
        turns: 0,
        prefixHash: null,
      };
      this.#sessions.set(key, entry);
    }

    const { prompt, messages: rendered } = buildPrompt({
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      continuation,
      provider: PROVIDER,
    });

    // Fingerprint the transcript this turn was built from. The next turn
    // recomputes it from everything before our reply and refuses to continue
    // when it differs — a guess at "how many messages the server saw" goes wrong
    // as soon as one turn emits several tool calls.
    const nextPrefixHash = transcriptDigest(options.messages);

    let reasoning = '';
    let text = '';
    let reasoningOpen = false;
    let sawContent = false;
    // What the server actually sent, so a silent page can be told apart from a
    // page whose frames the parser did not recognize.
    const seen = { ready: 0, snapshot: 0, fragment: 0, content: 0, finished: 0, other: 0 };

    if (process.env.DEEPSEEK_WEB_DEBUG) {
      const shape = options.messages
        .map((message, index) => `${index}:${message.role}/${message.source?.provider ?? '-'}`)
        .join(' ');
      console.error(
        `[web-debug] session=${String(options.sessionId).slice(-8)} turns=${entry.turns} ` +
          `continuation=${continuation} promptChars=${prompt.length} ` +
          `prefixHash=${String(entry.prefixHash).slice(0, 8)} recomputed=${nextPrefixHash.slice(0, 8)} ` +
          `messages=[${shape}]`,
      );
    }

    // Upload happens inside the guarded region: a refused upload is a turn
    // failure like any other, and must surface as `finish/error` rather than
    // escaping as an unhandled rejection in the middle of a stream.
    let refFileIds = [];
    const images = collectImages(rendered);
    // A retry must start from the same parent as the failed attempt, even if a
    // `ready` frame had already advanced `lastMessageId` before the failure.
    const parentMessageId = entry.lastMessageId;
    try {
      if (images.length > 0) refFileIds = await this.#uploadImages(images, token, options.signal);

      let retriedStaleFiles = false;
      for (;;) {
        try {
          for await (const frame of this.#client.completion({
            sessionId: entry.id,
            parentMessageId,
            prompt,
            refFileIds,
            token,
            thinking: options.reasoningEffort === 'high',
            search: this.#config.webSearch,
            signal: options.signal,
          })) {
            if (frame.kind === 'ready') {
              seen.ready += 1;
              // The id this turn's reply carries, and the parent of the next turn.
              entry.lastMessageId = frame.responseMessageId;
              continue;
            }

            if (frame.kind === 'snapshot' || frame.kind === 'fragment') {
              if (frame.kind === 'snapshot') seen.snapshot += 1;
              else seen.fragment += 1;
              const fragment = frame.kind === 'snapshot' ? frame.response.fragments?.at(-1) : frame.fragment;
              if (!fragment || typeof fragment.content !== 'string' || fragment.content.length === 0) continue;
              if (fragment.type === 'THINK') {
                if (!reasoningOpen) {
                  yield { type: 'block-start', index: 0, blockType: 'reasoning' };
                  reasoningOpen = true;
                }
                reasoning += fragment.content;
                sawContent = true;
                yield { type: 'reasoning-delta', index: 0, text: fragment.content };
              } else if (fragment.type === 'RESPONSE') {
                text += fragment.content;
                sawContent = true;
              }
              continue;
            }

            if (frame.kind === 'content') {
              seen.content += 1;
              if (frame.fragmentType === 'THINK') {
                if (!reasoningOpen) {
                  yield { type: 'block-start', index: 0, blockType: 'reasoning' };
                  reasoningOpen = true;
                }
                reasoning += frame.text;
                sawContent = true;
                yield { type: 'reasoning-delta', index: 0, text: frame.text };
              } else if (frame.fragmentType === 'RESPONSE') {
                text += frame.text;
                sawContent = true;
              }
              continue;
            }

            if (frame.kind === 'finished') seen.finished += 1;
            else seen.other += 1;
          }
          break;
        } catch (error) {
          // `INVALID_REF_FILE` means the site no longer recognizes an id we
          // cached — normally because the browser re-login rotated the token
          // the upload was authorized with. Re-upload once and retry the turn.
          // A fresh upload that is refused again is a real failure.
          if (error?.code === 'INVALID_REF_FILE' && !retriedStaleFiles && images.length > 0) {
            retriedStaleFiles = true;
            this.#uploads.clear();
            refFileIds = await this.#uploadImages(images, token, options.signal);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (reasoningOpen) {
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
      }
      const aborted = error?.name === 'AbortError' || options.signal?.aborted === true;
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: 'the turn was cancelled', code: 'ABORTED' } }
          : {
              kind: 'error',
              failure: { message: error?.message ?? String(error), code: error?.code ?? 'TRANSPORT' },
            },
      };
      return;
    }

    let index = 0;
    if (reasoningOpen) {
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
      index = 1;
    }

    const reply = parseReply(text);
    if (reply.text.length > 0) {
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text: reply.text };
      yield { type: 'block-end', index, block: { type: 'text', text: reply.text } };
      index += 1;
    }

    // A reply may ask for several tools at once; each becomes its own block so
    // the loop can run them together.
    for (const [position, call] of reply.calls.entries()) {
      const id = `web-call-${entry.id.slice(0, 8)}-${entry.turns}-${position}`;
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index,
        id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
      };
      index += 1;
    }

    if (!sawContent && reply.calls.length === 0) {
      // Distinguish "the page said nothing" from "the page said something the
      // parser did not recognize": the first is the server, the second is a bug
      // here, and the message is the only clue the user gets.
      const frames = `ready=${seen.ready} snapshot=${seen.snapshot} fragment=${seen.fragment} content=${seen.content} finished=${seen.finished}`;
      const detail = seen.content > 0 || seen.fragment > 0
        ? ` (the server sent content frames the parser did not type: ${frames})`
        : ` (${frames})`;

      // This turn's prompt is already in the server's copy with no answer after
      // it. Continuing that conversation would stack the next attempt on top of
      // an unanswered message, so the conversation is dropped and the retry
      // replays the transcript into a fresh one.
      this.#sessions.delete(options.sessionId ?? 'anonymous');
      void this.#client.deleteSession(entry.id, token);

      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `the web page returned an empty answer${detail}`, code: 'EMPTY_RESPONSE' },
        },
      };
      return;
    }

    entry.turns += 1;
    // The server has answered this transcript; the next turn re-derives the
    // same digest from everything before this reply and continues only on a match.
    entry.prefixHash = nextPrefixHash;

    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(1, Math.ceil(prompt.length / 3)),
        outputTokens: Math.max(1, Math.ceil((text.length + reasoning.length) / 3)),
      },
    };
    yield { type: 'finish', reason: { kind: reply.calls.length > 0 ? 'tool-calls' : 'stop' } };
  }

  /** Drop one harness session's server conversation. */
  async release(sessionId) {
    const key = sessionId ?? 'anonymous';
    const entry = this.#sessions.get(key);
    this.#sessions.delete(key);
    if (!entry) return;
    const token = await this.#client.resolveToken().catch(() => null);
    if (token) await this.#client.deleteSession(entry.id, token);
  }
}

export { PROVIDER, MODEL_ID };

/** File extension the upload form should carry for one media type. */
function extensionOf(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}
