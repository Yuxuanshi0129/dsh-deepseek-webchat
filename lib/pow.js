/**
 * DeepSeekHashV1 proof-of-work solver.
 *
 * The challenge answers `salt_expireAt_answer` such that a Keccak-family hash of
 * it is below `difficulty`. The web page performs that search inside a
 * wasm-bindgen module; the same module (MIT, from Jerry-Wu-GitHub/deepseek-pow)
 * ships in `assets/` so the search stays local and fast.
 */
import { readFile } from 'node:fs/promises';

let modulePromise;

/** Load and instantiate the solver module once per process. */
function loadModule() {
  modulePromise ??= (async () => {
    const url = new URL('../assets/sha3_wasm_v1.wasm', import.meta.url);
    const bytes = await readFile(url);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports;
  })();
  return modulePromise;
}

/**
 * Solve one challenge.
 * @param challenge the `data.biz_data.challenge` payload.
 * @returns the answer as a number.
 */
export async function solveChallenge(challenge) {
  const exports = await loadModule();
  const memory = exports.memory;
  const encoder = new TextEncoder();

  const write = (bytes) => {
    const pointer = exports.__wbindgen_export_0(bytes.length, 1) >>> 0;
    if (bytes.length > 0) new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    return pointer;
  };

  const challengeBytes = encoder.encode(challenge.challenge);
  const prefixBytes = encoder.encode(`${challenge.salt}_${challenge.expire_at}_`);
  const challengePointer = write(challengeBytes);
  const prefixPointer = write(prefixBytes);

  // wasm-bindgen reserves a 16-byte return slot: i32 status at +0, f64 answer at +8.
  const slot = exports.__wbindgen_add_to_stack_pointer(-16) >>> 0;
  try {
    exports.wasm_solve(
      slot,
      challengePointer,
      challengeBytes.length,
      prefixPointer,
      prefixBytes.length,
      challenge.difficulty,
    );
    const view = new DataView(memory.buffer);
    if (view.getInt32(slot, true) === 0) {
      throw new Error('the proof-of-work search found no answer; retry the request');
    }
    return view.getFloat64(slot + 8, true);
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

/**
 * Build the `x-ds-pow-response` header value for one target path.
 * @param challenge the server challenge.
 * @param answer the solved answer.
 */
export function encodePowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
