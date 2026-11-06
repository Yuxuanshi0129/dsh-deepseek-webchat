# DeepSeek Web Chat

Use your **chat.deepseek.com** web session as a model inside DeepSeek Harness.
No API key, no per-token billing — it drives the same web chat you use in the
browser, including its tools.

## What it is

A `dsh` plugin that registers an LLM adapter for the provider route
`deepseek-web`. When you select the model **DeepSeek Web Chat**, the harness
sends your conversation to `https://chat.deepseek.com` using the login token
already sitting in your browser, and streams the answer back.

## Why a token is needed at all

The web chat is free to use, but it is not anonymous: every request carries
`Authorization: Bearer <userToken>`, the same 64-character value the site stores
in your browser after you sign in. That is a **session token, not an API key** —
there is no key to buy, generate, or paste from a dashboard. The plugin reads it
from your browser profile automatically.

## Setup

1. Sign in at <https://chat.deepseek.com> in Chrome, Edge, Brave, or Chromium.
2. In the harness, open the model picker and select **DeepSeek Web Chat**
   (provider `deepseek-web`).
3. Start chatting.

No configuration is required. The plugin finds the token on its own.

### Optional configuration

| Field | Default | Meaning |
|---|---|---|
| `tokenEnv` | `DEEPSEEK_WEB_TOKEN` | Credential name to read a token from, for machines with no browser session. Leave empty to rely on the browser. |
| `readBrowserToken` | `true` | Read the signed-in token from a local Chromium-family profile. |
| `webSearch` | `false` | Ask the web chat to search the web on every turn. Slower; adds citations. |
| `baseURL` | `https://chat.deepseek.com` | Only change this for a mirror or proxy. |

If you prefer an explicit token, set the credential instead of relying on
browser scraping:

```powershell
$env:DEEPSEEK_WEB_TOKEN = "<64-char userToken>"
```

## Install from GitHub

```powershell
dsh plugin --profile <profile> add "https://github.com/Yuxuanshi0129/dsh-deepseek-webchat"
```

Or clone it and link the directory:

```powershell
git clone https://github.com/Yuxuanshi0129/dsh-deepseek-webchat
cd dsh-deepseek-web
pnpm install --config.node-linker=hoisted
dsh plugin --profile <profile> add .
```

Then reload the plugin (disable and re-enable `include:deepseek-web` in the
harness), and select **DeepSeek Web Chat** in the model picker.

To use a private `userToken` instead of the signed-in browser session:

```powershell
$env:DEEPSEEK_WEB_TOKEN = "<64-char userToken>"
```

## One login, one session

DeepSeek keeps **one active login per account**. Signing in again — or letting
another tab sign out — invalidates the token the plugin is holding. When that
happens the harness reports:

```
no working chat.deepseek.com token: sign in to chat.deepseek.com in a local
browser, or set the credential "DEEPSEEK_WEB_TOKEN"
```

Sign in again in the browser and retry; the plugin re-reads the token
automatically, checking each candidate against the server rather than trusting
file timestamps.

## How a harness session maps to a web session

Each harness session gets its own `chat.deepseek.com` conversation, created on
first use and reused for later turns by threading `parent_message_id`. The
conversation is deleted when the harness session is disposed.

Turns are continued rather than replayed: before each call the plugin compares
a content digest of the transcript against what the web conversation has
already seen, and only sends the new tail. Token usage stays flat across a long
tool loop instead of growing quadratically.

## Tool calling

The web endpoint has no tool-schema channel, so tools are described in the
prompt and the model is asked to answer with

```xml
<tool_call>{"name": "read", "arguments": {"file_path": "a.txt"}}</tool_call>
```

Several calls in one reply run in parallel. The parser also accepts DeepSeek's
native DSML form (`<｜｜DSML｜｜invoke ...>`) because the model sometimes emits it
unprompted, and stray closing tags are stripped from visible text.

## Images

Images work. The web chat has no inline-image field: an image is a file the
account owns, so the plugin uploads each one through
`POST /api/v0/file/upload_file` (multipart, its own proof of work), waits for
the server to finish parsing it, and sends only the resulting id in
`ref_file_ids`. The prompt carries a marker such as

```
[image 1 is attached to this message and you can see it directly — do not call a tool to read it]
```

so the model knows where the picture sat in the message *and* that it does not
need to open a file. Without the second half the model tends to call
`read_image` on a path guessed from the file name, which fails because the
picture was never on disk.

Uploads are cached per attachment id — the bytes never change, so a screenshot
mentioned again later in the same session is not re-uploaded.

## Capabilities and limits

- **Images yes, other files no.** PNG, JPEG, WebP and GIF are sent. Other
  attachments (PDFs, archives, source files) are not forwarded; the model only
  sees their names.
- **128k context**, 8k default output, reasoning effort `off` or `high`
  (`high` enables the site's thinking mode).
- **Latency** is a browser round trip plus the site's own PoW challenge
  (~20–30 ms, solved locally with the bundled WebAssembly module), and one
  upload round trip per new image.
- **Rate limits** are the website's, not an API's. Heavy parallel use looks like
  a human refreshing a lot.
- **Occasional empty answers.** The page sometimes finishes a turn with no
  content at all. The plugin reports that as `EMPTY_RESPONSE` (with the frame
  counts it saw), drops the server-side conversation so the next attempt does
  not stack on an unanswered message, and the kernel retries it.
- **Login rotation invalidates uploads.** Signing in again replaces the active
  `userToken` (the site's `storageDrivenLogout` rule). Uploaded files belong to
  the login that created them, so the plugin pins one token across the upload
  and its completion, and re-uploads once if the site answers
  `invalid ref file id`. A plain-JSON refusal like `{"code":0,...,
  "data":{"biz_code":9,"biz_msg":"invalid ref file id"}}` is reported with its
  business code and message rather than the useless `refused: 0`.
- **Not for unattended automation.** The login is tied to a human browser
  session, and the account is yours.

## Files

| Path | Purpose |
|---|---|
| `index.js` | Plugin entry: Config, adapter registration, token state machine. |
| `lib/adapter.js` | `LlmAdapter` implementation — streaming, tool calls, replay. |
| `lib/client.js` | HTTP client: PoW header, session lifecycle, SSE parsing. |
| `lib/pow.js` | WebAssembly proof-of-work solver. |
| `lib/prompt.js` | Transcript rendering, tool protocol, reply parsing. |
| `lib/token.js` | Chromium Local Storage reader. |
| `assets/sha3_wasm_v1.wasm` | Upstream PoW module (MIT, see `THIRD_PARTY_NOTICES.md`). |

## Platform support

Reading the token directly from a browser profile currently works on **Windows
only** (`LOCALAPPDATA`). macOS and Linux paths are enumerated but not fully
supported yet; on those platforms set the `DEEPSEEK_WEB_TOKEN` credential
instead.

## Disclaimer

This is an unofficial, community-built plugin. It drives the private
`chat.deepseek.com` web API using your own login session, which is **not a
public API** and may change or be blocked at any time. It is not affiliated with
or endorsed by DeepSeek. Use it at your own risk and in line with the site's
terms of service; be aware that automated use of a personal account may be
rate-limited or restricted. The bundled `sha3_wasm_v1.wasm` is third-party
(MIT, see `THIRD_PARTY_NOTICES.md`).

## License

MIT — see `THIRD_PARTY_NOTICES.md` for the third-party WebAssembly module.

## Credits

The proof-of-work module is `sha3_wasm_v1.wasm` from
[Jerry-Wu-GitHub/deepseek-pow](https://github.com/Jerry-Wu-GitHub/deepseek-pow),
MIT licensed. Full text in `THIRD_PARTY_NOTICES.md`.
