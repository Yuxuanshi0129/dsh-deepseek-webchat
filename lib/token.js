/**
 * Recover the `userToken` the DeepSeek web page keeps in Local Storage.
 *
 * The browser is the only place a signed-in session lives, so this reads the
 * Chromium Local Storage (LevelDB) files directly instead of asking the user to
 * copy a value out of DevTools. A running browser keeps the files locked on
 * Windows; a locked file is skipped rather than treated as an error, and the
 * caller falls back to a configured token.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chat.deepseek.com';

/** Every Chromium profile directory that could hold the origin. */
function candidateRoots() {
  const roots = [];
  const localAppData = process.env.LOCALAPPDATA;
  const home = homedir();
  const brands = ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Chromium'];
  if (localAppData) for (const brand of brands) roots.push(join(localAppData, brand, 'User Data'));
  if (process.platform === 'darwin') {
    for (const brand of ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser']) {
      roots.push(join(home, 'Library', 'Application Support', brand));
    }
  }
  if (process.platform === 'linux') {
    for (const brand of ['google-chrome', 'chromium', 'microsoft-edge']) {
      roots.push(join(home, '.config', brand));
    }
  }
  return roots;
}

/** Profile directories inside one browser root. */
async function profileDirs(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || name === 'Guest Profile' || /^Profile \d+$/.test(name))
    .map((name) => join(root, name, 'Local Storage', 'leveldb'));
}

/**
 * Pull the token out of one LevelDB byte blob.
 *
 * Matching on the literal key `userToken` is unreliable: LevelDB applies prefix
 * compression between adjacent keys, so a real record can appear as `userT` +
 * a length prefix + binary + the quoted value. Matching by shape alone is worse
 * — it also collects refresh tokens, WAF challenge state, and telemetry ids.
 *
 * So the shape is used to *collect* candidates and the server decides which one
 * is live. The shape is deliberately narrow: the web token is 64 characters of
 * URL-safe base64 inside quotes. Every extra candidate costs one cheap
 * `users/current` call, and a wrong pick costs a failed turn.
 *
 * @param buffer raw file contents.
 * @returns candidate tokens in the order they were found.
 */
function tokensIn(buffer) {
  const found = [];
  const text = buffer.toString('latin1');

  // 64-char quoted value; the trailing quote is what separates it from the
  // longer blobs (JWTs, WAF payloads) that share the same alphabet.
  for (const match of text.matchAll(/"([A-Za-z0-9_\-+/=]{64})"/g)) found.push(match[1]);

  return found;
}

/**
 * Find every plausible web token on this machine, newest first.
 *
 * More than one is returned on purpose: the page rotates its `userToken`, and
 * older copies linger in LevelDB after a re-login, so the newest-looking string
 * is not always the live one. The caller verifies them against the server rather
 * than trusting this order.
 *
 * @returns candidate tokens, most recently written first.
 */
export async function readBrowserTokens() {
  const candidates = [];
  for (const root of candidateRoots()) {
    for (const leveldb of await profileDirs(root)) {
      let files;
      try {
        files = await readdir(leveldb);
      } catch {
        continue;
      }
      for (const name of files) {
        const path = join(leveldb, name);
        try {
          const info = await stat(path);
          if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024) continue;
          const buffer = await readFile(path);
          if (!buffer.includes(Buffer.from(ORIGIN, 'latin1'))) continue;
          for (const token of tokensIn(buffer)) candidates.push({ token, mtime: info.mtimeMs });
        } catch {
          // A live browser holds the file open; another profile may still answer.
        }
      }
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime);

  const ordered = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.token)) continue;
    seen.add(candidate.token);
    ordered.push(candidate.token);
  }
  return ordered;
}

/**
 * Find the most likely current web token.
 * @returns the token, or `undefined` when no signed-in profile is readable.
 */
export async function readBrowserToken() {
  return (await readBrowserTokens())[0];
}

