/**
 * Translate between the harness conversation vocabulary and one web-chat prompt.
 *
 * The consumer endpoint takes a single `prompt` string and keeps its own
 * server-side history keyed by `parent_message_id`. Two consequences shape this
 * module:
 *
 * 1. Tool calls must be requested in text, because the endpoint has no tool
 *    schema of its own. A short protocol block teaches the format, and the
 *    assistant's reply is parsed back into harness tool-call blocks.
 * 2. Because history lives on the server, a continuation only needs the new
 *    user turn — unless the transcript diverged (a fork, an edited message, or
 *    a session whose server conversation was never opened), in which case the
 *    whole visible transcript is replayed as one prompt.
 */
import { createHash } from 'node:crypto';

export const TOOL_PROTOCOL = `## Tool calls

You are running inside a terminal agent. You act by calling tools, not by describing what you would do.

Call tools with this exact form:

<tool_call>{"name": "<tool name>", "arguments": {<json arguments>}}</tool_call>

Rules:
- One block per tool call. Put any short explanation before the first block.
- Never write text after the last closing tag.
- Do not use any other markup for tool calls — no \`DSML\`, no XML invokes, no bare JSON. Only the \`<tool_call>\` block above is understood.
- The harness runs each tool and replies with a \`<tool_result>\` message. Continue from there.
- Arguments must be valid JSON matching the tool's schema.
- When the task is finished, reply with ordinary prose and no <tool_call> block.`;

/** Render the tool catalog the model is allowed to call. */
export function describeTools(tools) {
  if (!tools || tools.length === 0) return '';
  const lines = tools.map((tool) => {
    const schema = JSON.stringify(tool.parameters ?? { type: 'object', properties: {} });
    return `- \`${tool.name}\` — ${tool.description}\n  parameters: ${schema}`;
  });
  return `## Available tools\n\n${lines.join('\n')}`;
}

/**
 * Flatten one message's content blocks into prompt text.
 *
 * An image becomes a numbered marker rather than its bytes: the bytes travel as
 * an upload referenced by `ref_file_ids`, so the prompt only has to keep the
 * order the user attached them in. Numbers come from a counter shared by the
 * whole rendered transcript, so every image in a prompt has its own number and
 * the numbers line up with the `ref_file_ids` order.
 *
 * @param message the message to render.
 * @param counter shared `{ value }` image counter for the enclosing render.
 */
function renderMessage(message, counter) {
  const parts = [];
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text);
        break;
      case 'reasoning':
        // The model's own earlier thinking is not part of the conversation it
        // needs to see again; the visible answer carries the decisions.
        break;
      case 'tool-call':
        parts.push(`<tool_call>${JSON.stringify({ name: block.name, arguments: parseArguments(block.arguments) })}</tool_call>`);
        break;
      case 'image': {
        if (!block.attachment) break;
        // An offloaded image is one the harness already decided to drop from the
        // request; sending it would contradict that decision.
        if (block.offloaded === true) {
          parts.push('[image omitted by the harness]');
          break;
        }
        counter.value += 1;
        // The wording has to say the picture is already visible. A bare
        // "[image attached]" reads like a file reference, and the model then
        // calls `read_image` with a path it invented from the file name — a
        // turn that fails on a file that was never on disk.
        parts.push(
          `[image ${counter.value} is attached to this message and you can see it directly — do not call a tool to read it]`,
        );
        break;
      }
      case 'file':
        parts.push(`[file: ${block.attachment?.name ?? 'attachment'}]`);
        break;
      default:
        break;
    }
    // A tool result arrives as a tool-role message, not a block.
  }
  return parts.join('\n').trim();
}

/**
 * Every image the transcript still wants sent, in attachment order.
 *
 * This is the order the server assigns to `ref_file_ids`, so it must match the
 * order the markers appear in the prompt — hence one walk over the messages
 * rather than one per message.
 *
 * @param messages the messages whose images will be uploaded.
 * @returns the durable image references, oldest first.
 */
export function collectImages(messages) {
  const refs = [];
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'image') continue;
      if (block.offloaded === true) continue;
      if (!block.attachment) continue;
      refs.push(block.attachment);
    }
  }
  return refs;
}

/** Arguments are raw JSON strings in the harness vocabulary. */
function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** One line per non-user turn, used when replaying a transcript. */
function renderTranscript(messages) {
  const blocks = [];
  // One counter for the whole render: a prefix renders its images with the same
  // numbers it would get in the full transcript, which is what lets the
  // continuation digest compare a slice against a whole.
  const counter = { value: 0 };
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    const body = renderMessage(message, counter);
    if (message.role === 'tool') {
      const text = (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) blocks.push(`<tool_result>\n${text}\n</tool_result>`);
      continue;
    }
    if (!body) continue;
    // Plain `User:`/`Assistant:` prefixes rather than paired tags: a tag pair
    // invites the model to close the tag itself, which then shows up as stray
    // markup in the visible answer.
    const label = message.role === 'assistant' ? 'Assistant' : 'User';
    blocks.push(`${label}: ${body}`);
  }
  return blocks.join('\n\n');
}

/**
 * Decide whether the server's copy of the conversation is still a prefix of the
 * harness transcript.
 *
 * The server keeps its own history, so appending is safe only while the visible
 * transcript is that history plus the new tail. Rather than guessing how many
 * messages the server saw — a count that goes wrong as soon as one turn emits
 * several tool calls — this compares content: the transcript that preceded our
 * last reply must still render to the same digest. An edited message, a fork, or
 * a rewind breaks that, and the whole conversation is replayed instead.
 *
 * Only the part before our own reply is fingerprinted, because the reply's own
 * rendering (a `<tool_call>` block) never matches the raw markup the server
 * actually received.
 *
 * @param options.messages the full visible transcript.
 * @param options.provider the provider id that owns the server-side replies.
 * @param options.prefixHash digest of the transcript sent before the last reply.
 * @returns `{ continuation, boundary }`; `boundary` is the last message the server answered.
 */
export function canContinue({ messages, provider, prefixHash }) {
  const boundary = lastProviderReply(messages, provider);
  if (boundary === -1) return { continuation: false, boundary };

  if (typeof prefixHash !== 'string') return { continuation: false, boundary };
  if (digest(renderTranscript(messages.slice(0, boundary))) !== prefixHash) {
    return { continuation: false, boundary };
  }

  // One user turn is a normal follow-up; more than one means the transcript
  // gained a turn the server never answered.
  const tail = messages.slice(boundary + 1);
  if (tail.filter((message) => message.role === 'user').length > 1) {
    return { continuation: false, boundary };
  }
  return { continuation: true, boundary };
}

/** Digest of a whole transcript, recorded before a turn and checked on the next. */
export function transcriptDigest(messages) {
  return digest(renderTranscript(messages));
}


/** Index of the last assistant message this provider produced, or -1. */
export function lastProviderReply(messages, provider) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.source?.provider === provider) return index;
  }
  return -1;
}

/** Content digests, so a comparison is cheap and does not hold transcripts alive. */
export function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}


/**
 * Build the prompt for one turn.
 *
 * The server keeps its own copy of the conversation, so a later turn only needs
 * what the server has not seen. Everything after the last assistant message
 * this provider produced is new: usually one tool result, or one user turn. A
 * first turn — and any turn whose history the server cannot have, such as after
 * a fork — replays the whole transcript with the standing instructions.
 *
 * @param options.messages the full visible transcript.
 * @param options.system the assembled system prompt.
 * @param options.tools the tool schemas available this step.
 * @param options.continuation true when the server already holds this prefix.
 * @param options.provider the provider id that owns the server-side replies.
 * @returns the prompt text, plus the messages it was rendered from so the caller
 *   knows which images still have to be uploaded for this turn.
 */
export function buildPrompt({ messages, system, tools, continuation, provider }) {
  const instructions = [system, describeTools(tools), TOOL_PROTOCOL].filter(Boolean).join('\n\n');

  if (continuation) {
    let boundary = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && message.source?.provider === provider) {
        boundary = index;
        break;
      }
    }
    const tail = boundary === -1 ? messages : messages.slice(boundary + 1);
    const body = renderTranscript(tail);
    if (body.length > 0) return { prompt: body, messages: tail };
    // Nothing new to say: resend the last user turn so the server answers again.
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    return lastUser
      ? { prompt: renderTranscript([lastUser]), messages: [lastUser] }
      : { prompt: renderTranscript(messages), messages };
  }

  const body = renderTranscript(messages);
  return { prompt: `${instructions}\n\n--- conversation so far ---\n\n${body}`, messages };
}

/**
 * Parse one assistant reply into visible text and any tool calls it asked for.
 *
 * Two call syntaxes are accepted. The documented `<tool_call>` JSON block is the
 * one the protocol asks for; the DeepSeek-native DSML invoke form is accepted
 * too, because the web model sometimes reaches for it on its own and a reply
 * that is silently treated as prose would strand the turn.
 *
 * @param text the assistant's whole visible answer.
 * @returns the text with the calls removed, plus every call found, in order.
 */
export function parseReply(text) {
  const json = parseJsonCalls(text);
  if (json.calls.length > 0) return { text: stripStrayMarkup(json.text), calls: json.calls };

  const dsml = parseDsmlCalls(text);
  if (dsml.calls.length > 0) return { text: stripStrayMarkup(dsml.text), calls: dsml.calls };

  return { text: stripStrayMarkup(text.trim()), calls: [] };
}

/**
 * Remove leftover protocol punctuation from the visible answer.
 *
 * The model sometimes echoes a closing tag it saw in the transcript — a bare
 * `</tool_call>`, or an `</assistant>` from an older prompt shape — after the
 * real call. Those are markup, not prose, and showing them looks like a bug.
 */
function stripStrayMarkup(text) {
  return text
    .replace(/<\/?(?:tool_call|tool_result|assistant|user)>/gi, '')
    .replace(/<\/?｜｜DSML｜｜[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The documented form: one or more `<tool_call>{…}</tool_call>` blocks. */
function parseJsonCalls(text) {
  const pattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  const calls = [];
  const spans = [];

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      // A malformed block is left in the text so the model can see its own
      // mistake rather than having it quietly dropped.
      continue;
    }
    if (typeof parsed?.name !== 'string' || parsed.name.length === 0) continue;
    calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) });
    spans.push([match.index, match.index + match[0].length]);
  }

  if (calls.length === 0) return { text: text.trim(), calls: [] };
  return { text: removeSpans(text, spans), calls };
}

/** The DeepSeek-native form, e.g. `<｜｜DSML｜｜ invoke name="read">…`. */
const DSML_MARK = '｜｜DSML｜｜';
const DSML_INVOKE = new RegExp(`<${DSML_MARK}\\s*invoke\\b([^>]*)>`, 'g');
const DSML_PARAMETER = new RegExp(
  `<${DSML_MARK}\\s*parameter\\b([^>]*)>([\\s\\S]*?)<\\/${DSML_MARK}\\s*parameter>`,
  'g',
);

/** Parse `name="x" string="true"` style attribute lists. */
function attributes(raw) {
  const found = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
    found[match[1]] = match[2];
  }
  return found;
}

function parseDsmlCalls(text) {
  const calls = [];
  for (let match = DSML_INVOKE.exec(text); match !== null; match = DSML_INVOKE.exec(text)) {
    const name = attributes(match[1]).name;
    if (!name) continue;

    const bodyStart = match.index + match[0].length;
    const close = text.slice(bodyStart).search(new RegExp(`<\\/${DSML_MARK}\\s*invoke>`));
    const body = close === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyStart + close);

    const args = {};
    DSML_PARAMETER.lastIndex = 0;
    for (let param = DSML_PARAMETER.exec(body); param !== null; param = DSML_PARAMETER.exec(body)) {
      const meta = attributes(param[1]);
      if (!meta.name) continue;
      const value = param[2];
      if (meta.string === 'true') args[meta.name] = value;
      else {
        try {
          args[meta.name] = JSON.parse(value);
        } catch {
          args[meta.name] = value;
        }
      }
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  }

  if (calls.length === 0) return { text: text.trim(), calls: [] };

  // Drop the whole markup run: from the first marker to the last closing one,
  // so a `calls` wrapper around the invokes disappears with them.
  const first = text.indexOf(DSML_MARK);
  const lastClose = text.lastIndexOf(`</${DSML_MARK}`);
  const open = first === -1 ? 0 : Math.max(0, text.lastIndexOf('<', first));
  const end = lastClose === -1 ? text.length : text.indexOf('>', lastClose) + 1 || text.length;
  return { text: removeSpans(text, [[open, end]]), calls };
}

function removeSpans(text, spans) {
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  out += text.slice(cursor);
  return out.trim();
}

