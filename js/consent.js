// THERMITE — acknowledgement.
//
// What this is: a gate in the interface. The pour button does not work until
// the person using it has said, in this browser, that they understand what
// Thermite does with their code.
//
// What this is NOT: a record of acceptance. Thermite has no server, so there is
// nothing that could witness a click. Any "acceptance record" a static site
// claims to hold is a value the user's own browser wrote and can rewrite. If
// you need server-authoritative, tamper-evident proof of acceptance — the kind
// that survives a dispute — this architecture cannot give it to you, and this
// file does not pretend otherwise. That limitation is stated in the terms
// themselves rather than hidden here.

export const TERMS_VERSION = '2026-08-20';

const SESSION_KEY = 'thermite.ack';
const DEVICE_KEY = 'thermite.ack.device';

export const ACKS = [
  {
    id: 'execution',
    text: 'I understand that Thermite compiles my Rust project on GitHub-hosted runners under my own GitHub account, that compiling Rust executes code from build scripts, procedural macros and dependencies, and that I am responsible for the code I submit.',
  },
  {
    id: 'terms',
    text: 'I have read the Thermite terms and security information, including that encryption protects confidentiality and does not make the build environment a sandbox.',
  },
];

function read(store, key) {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v?.version === TERMS_VERSION ? v : null;
  } catch { return null; }
}

/** @returns {{accepted:boolean, at:string|null, scope:'session'|'device'|null}} */
export function state() {
  const s = read(sessionStorage, SESSION_KEY);
  if (s) return { accepted: true, at: s.at, scope: 'session' };
  const d = read(localStorage, DEVICE_KEY);
  if (d) return { accepted: true, at: d.at, scope: 'device' };
  return { accepted: false, at: null, scope: null };
}

export function accept({ remember = false } = {}) {
  const record = {
    version: TERMS_VERSION,
    at: new Date().toISOString(),
    acks: ACKS.map((a) => a.id),
  };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(record)); } catch {}
  if (remember) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify(record)); } catch {} }
  return record;
}

export function withdraw() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem(DEVICE_KEY); } catch {}
}
