// Live Hebrew -> multi-language speech translation broadcast server.
//
// FREE mode (default):
//   Speaker talks in Chrome (desktop/Android) -> browser Web Speech API transcribes
//   Hebrew for free -> sends text over WebSocket -> server translates (free Google/MyMemory)
//   -> broadcasts to viewers over WebSocket. No API key required.
//
// Optional paid engines (openai / deepl) available via env for higher quality.

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const SOURCE_LANG = process.env.SOURCE_LANG || 'he'; // language the speaker talks in
const TRANSLATION_ENGINE = (process.env.TRANSLATION_ENGINE || 'free').toLowerCase(); // free | claude | openai | deepl
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5'; // fast + cheap, good for live

// Context handed to the quality (LLM) engine so it picks the right register + terms.
const TALK_CONTEXT = process.env.TALK_CONTEXT ||
  'A company CEO is speaking to employees at an informal happy-hour gathering about ' +
  'the quarter\'s business results and the work happening at the companies "ATM" and "Steerlinq". ' +
  'The audience is the company\'s Russian- and English-speaking employees. ' +
  'Keep the company names ATM and Steerlinq in Latin letters. ' +
  'Use natural, warm-but-professional workplace language appropriate for staff.';

// Which engine (if any) is a paid, context-aware "quality" engine that needs a key.
function premiumEngine() {
  if (TRANSLATION_ENGINE === 'claude' && ANTHROPIC_API_KEY) return 'claude';
  if (TRANSLATION_ENGINE === 'openai' && OPENAI_API_KEY) return 'openai';
  if (TRANSLATION_ENGINE === 'deepl' && DEEPL_API_KEY) return 'deepl';
  return null;
}

if (TRANSLATION_ENGINE === 'claude' && !ANTHROPIC_API_KEY) {
  console.warn('\n[!] TRANSLATION_ENGINE=claude but ANTHROPIC_API_KEY is not set.\n');
}
if (TRANSLATION_ENGINE === 'openai' && !OPENAI_API_KEY) {
  console.warn('\n[!] TRANSLATION_ENGINE=openai but OPENAI_API_KEY is not set.\n');
}
if (TRANSLATION_ENGINE === 'deepl' && !DEEPL_API_KEY) {
  console.warn('\n[!] TRANSLATION_ENGINE=deepl but DEEPL_API_KEY is not set.\n');
}

// ---- Glossary: normalize company names / known terms in the Hebrew BEFORE translating,
// so every engine keeps them correct (and mis-hearings get fixed). Edit freely. ----
const GLOSSARY = [
  { re: /א\.\s?צ\.\s?מ/g, to: 'ATM' },              // א.צ.מ
  { re: /אצ["'״׳]?מ/g, to: 'ATM' },                 // אצמ / אצ"מ / אצ׳מ
  { re: /\bATM\b/gi, to: 'ATM' },
  { re: /ס[טת][יי]?[רר]?לינ[קגכ]|סטרלינ[קגכ]/g, to: 'Steerlinq' }, // סטירלינק / סטרלינג …
  { re: /steer\s*lin[qgk]/gi, to: 'Steerlinq' },
];
function applyGlossary(t) {
  for (const { re, to } of GLOSSARY) t = t.replace(re, to);
  return t;
}

// ---- Language catalog (code -> display name). Russian first (priority). ----
const LANGUAGES = {
  ru: 'Russian',
  en: 'English',
  ar: 'Arabic',
  he: 'Hebrew',
  uk: 'Ukrainian',
  am: 'Amharic',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ro: 'Romanian',
  pt: 'Portuguese',
  it: 'Italian',
  tr: 'Turkish',
  zh: 'Chinese (Simplified)',
  hi: 'Hindi',
};

// Google Translate uses a few non-ISO codes.
function googleCode(code) {
  if (code === 'zh') return 'zh-CN';
  return code;
}

// ---- In-memory session store (single instance). ----
// sessionId -> { token, viewers: Set<ws>, createdAt, lastActivity }
const sessions = new Map();

function newId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createSession() {
  const sessionId = newId(9);
  const token = newId(12);
  sessions.set(sessionId, {
    token,
    viewers: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    recentFinals: [], // last few finished Hebrew sentences, for rolling context
  });
  return { sessionId, token };
}

// Clean up idle sessions every 10 minutes (2h idle timeout).
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > 2 * 60 * 60 * 1000 && s.viewers.size === 0) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ------------------------- Translation engines -------------------------
const translateCache = new Map(); // `${lang}::${text}` -> translated

// Free: unofficial Google endpoint (best quality, no key).
async function translateGoogleFree(text, targetCode) {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=${encodeURIComponent(SOURCE_LANG)}&tl=${encodeURIComponent(googleCode(targetCode))}` +
    `&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('google-free ' + res.status);
  const data = await res.json();
  // data[0] = [[translatedChunk, originalChunk, ...], ...]
  return (data[0] || []).map((seg) => seg[0]).join('');
}

// Free fallback: MyMemory (no key).
async function translateMyMemory(text, targetCode) {
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(SOURCE_LANG)}|${encodeURIComponent(targetCode)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('mymemory ' + res.status);
  const data = await res.json();
  return data.responseData?.translatedText || text;
}

// Quality engine: context-aware translation via Claude (fast Haiku model).
// `context` = the previous Hebrew sentence(s), used only to keep terminology and
// pronouns consistent across the talk — not translated.
async function translateClaude(text, targetName, context) {
  const userContent = context
    ? `Prior sentences (context only — do NOT translate these):\n${context}\n\nSentence to translate:\n${text}`
    : text;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system:
        `You are a professional simultaneous interpreter at a company event. Context: ${TALK_CONTEXT}\n` +
        `Translate the Hebrew into ${targetName}. If the message includes "Prior sentences (context only...)", ` +
        `use them ONLY to keep terminology, names, and pronouns consistent — translate ONLY the text under "Sentence to translate". ` +
        `Output ONLY the translation — no notes, no quotes, no transliteration, no explanation. ` +
        `Keep the company names ATM and Steerlinq unchanged. Preserve names, numbers, and tone, ` +
        `and use natural ${targetName} suited to employees hearing their CEO.`,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`claude ${res.status}`);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  return (block?.text || '').trim();
}

async function translateOpenAI(text, targetName, context) {
  const userContent = context
    ? `Prior sentences (context only — do NOT translate these):\n${context}\n\nSentence to translate:\n${text}`
    : text;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `You are a professional simultaneous interpreter at a company event. Context: ${TALK_CONTEXT}\n` +
            `Translate the Hebrew into ${targetName}. If the message includes prior context lines, use them only ` +
            `to keep terminology and pronouns consistent — translate ONLY the "Sentence to translate". ` +
            `Output ONLY the translation, no quotes, no notes. Keep ATM and Steerlinq unchanged. Preserve meaning, tone, names, and numbers.`,
        },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function translateDeepL(text, targetCode) {
  const host = DEEPL_API_KEY?.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', targetCode.toUpperCase());
  params.append('source_lang', SOURCE_LANG.toUpperCase());
  const res = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) throw new Error(`deepl ${res.status}`);
  const data = await res.json();
  return (data.translations?.[0]?.text || '').trim();
}

// Names that must survive translation verbatim (derived from the glossary targets).
const PROTECT_TERMS = [...new Set(GLOSSARY.map((g) => g.to))];
// Swap protected names for inert placeholders the translator won't touch, then restore.
function protectTerms(text) {
  const map = [];
  let t = text;
  PROTECT_TERMS.forEach((term, i) => {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    if (re.test(t)) {
      const ph = `QZX${i}XZQ`; // rare token; engines pass it through unchanged
      t = t.replace(re, ph);
      map.push([i, term]);
    }
  });
  return { t, map };
}
function restoreTerms(text, map) {
  for (const [i, term] of map) {
    // tolerate case changes / stray spaces the engine might introduce
    const re = new RegExp(`Q\\s*Z\\s*X\\s*${i}\\s*X\\s*Z\\s*Q`, 'gi');
    text = text.replace(re, term);
  }
  return text;
}

async function translateFree(text, langCode) {
  const { t, map } = protectTerms(text);
  let out;
  try {
    out = await translateGoogleFree(t, langCode);
  } catch (e1) {
    out = await translateMyMemory(t, langCode);
  }
  return restoreTerms(out, map);
}

// isFinal=true uses the paid quality engine (if configured); live partials stay on the
// fast free engine. So the mid-speech preview is quick, and the locked line is polished.
async function translate(text, langCode, isFinal, context) {
  if (langCode === SOURCE_LANG) return text; // no translation needed
  const engine = premiumEngine();
  const usePremium = isFinal && !!engine;
  // Context only affects premium finals; keep it out of the free-path cache key.
  const key = `${usePremium ? 'q' : 'f'}:${langCode}::${usePremium && context ? context + '|' : ''}${text}`;
  if (translateCache.has(key)) return translateCache.get(key);

  const name = LANGUAGES[langCode] || langCode;
  let out;
  try {
    if (usePremium && engine === 'claude') out = await translateClaude(text, name, context);
    else if (usePremium && engine === 'openai') out = await translateOpenAI(text, name, context);
    else if (usePremium && engine === 'deepl') out = await translateDeepL(text, langCode);
    else out = await translateFree(text, langCode);
  } catch (e) {
    console.error(`translate(${langCode}${usePremium ? ',quality' : ''}) error:`, e.message);
    // If the paid engine fails, fall back to free so viewers still get text.
    try {
      out = await translateFree(text, langCode);
    } catch (e2) {
      return null;
    }
  }

  if (translateCache.size > 5000) translateCache.clear();
  translateCache.set(key, out);
  return out;
}

// ------------------------- Handle a recognized Hebrew segment -------------------------
// msg = { text, isFinal, id, seq }
//   isFinal=false -> live partial (mid-speech), viewers update the SAME line by id.
//   isFinal=true  -> the sentence is done; viewers lock that line.
async function handleText(session, msg) {
  const hebrew = applyGlossary((msg.text || '').trim());
  if (hebrew.length < 1) return;

  const isFinal = !!msg.isFinal;
  const id = msg.id ?? 0;
  const seq = msg.seq ?? 0;

  session.lastActivity = Date.now();

  // Distinct languages currently requested by viewers.
  const wanted = new Set();
  for (const v of session.viewers) if (v.lang) wanted.add(v.lang);
  if (wanted.size === 0) return; // nobody watching

  // Rolling context: the previous finished sentence(s), for consistency on premium finals.
  const context = isFinal ? (session.recentFinals || []).join(' ') : '';

  const translations = {};
  await Promise.all(
    [...wanted].map(async (lang) => {
      translations[lang] = await translate(hebrew, lang, isFinal, context);
    })
  );

  // Remember this finished sentence for the next one's context (keep last 2).
  if (isFinal) {
    session.recentFinals.push(hebrew);
    if (session.recentFinals.length > 2) session.recentFinals.shift();
  }

  const type = isFinal ? 'segment' : 'partial';
  for (const v of session.viewers) {
    if (v.readyState !== v.OPEN) continue;
    const text = translations[v.lang];
    if (text == null) continue;
    v.send(JSON.stringify({ type, id, seq, source: hebrew, text, lang: v.lang }));
  }
}

// ------------------------- HTTP + WS wiring -------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/languages', (_req, res) => res.json(LANGUAGES));

app.post('/api/session', (_req, res) => {
  const { sessionId, token } = createSession();
  res.json({ sessionId, token });
});

app.get('/api/session/:id', (req, res) => {
  res.json({ exists: sessions.has(req.params.id) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/ws/speak' || p === '/ws/watch') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req, url) => {
  const p = url.pathname;
  const sessionId = url.searchParams.get('s');
  const session = sessions.get(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'session-not-found' }));
    ws.close();
    return;
  }

  if (p === '/ws/speak') {
    const token = url.searchParams.get('t');
    if (token !== session.token) {
      ws.send(JSON.stringify({ type: 'error', message: 'bad-token' }));
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ type: 'ready', role: 'speaker' }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'text') handleText(session, msg);
      } catch {}
    });
  } else if (p === '/ws/watch') {
    const lang = url.searchParams.get('lang') || 'ru';
    ws.lang = LANGUAGES[lang] ? lang : 'ru';
    session.viewers.add(ws);
    session.lastActivity = Date.now();
    ws.send(JSON.stringify({ type: 'ready', role: 'viewer', lang: ws.lang }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'setLang' && LANGUAGES[msg.lang]) {
          ws.lang = msg.lang;
          ws.send(JSON.stringify({ type: 'langSet', lang: msg.lang }));
        }
      } catch {}
    });
    ws.on('close', () => session.viewers.delete(ws));
  }
});

server.listen(PORT, () => {
  const eng = premiumEngine();
  const engine = eng === 'claude' ? `Claude(${CLAUDE_MODEL}) on finals + free on partials`
    : eng === 'openai' ? `OpenAI(${TRANSLATE_MODEL}) on finals + free on partials`
    : eng === 'deepl' ? 'DeepL on finals + free on partials'
    : 'FREE (Google/MyMemory, no key)';
  console.log(`\nLive translation server on http://localhost:${PORT}`);
  console.log(`Source=${SOURCE_LANG}  Translate=${engine}  STT=browser (Web Speech API, free)  Glossary=${GLOSSARY.length} terms\n`);
});
