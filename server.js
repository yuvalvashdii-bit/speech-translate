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
const TRANSLATION_ENGINE = (process.env.TRANSLATION_ENGINE || 'free').toLowerCase(); // free | openai | deepl
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

if (TRANSLATION_ENGINE === 'openai' && !OPENAI_API_KEY) {
  console.warn('\n[!] TRANSLATION_ENGINE=openai but OPENAI_API_KEY is not set.\n');
}
if (TRANSLATION_ENGINE === 'deepl' && !DEEPL_API_KEY) {
  console.warn('\n[!] TRANSLATION_ENGINE=deepl but DEEPL_API_KEY is not set.\n');
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

async function translateOpenAI(text, targetName) {
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
            `You are a professional simultaneous interpreter. Translate the user's text into ${targetName}. ` +
            `Output ONLY the translation, no quotes, no notes. Preserve meaning, tone, names, and numbers.`,
        },
        { role: 'user', content: text },
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

async function translate(text, langCode) {
  if (langCode === SOURCE_LANG) return text; // no translation needed
  const key = `${langCode}::${text}`;
  if (translateCache.has(key)) return translateCache.get(key);

  let out;
  try {
    if (TRANSLATION_ENGINE === 'openai' && OPENAI_API_KEY) {
      out = await translateOpenAI(text, LANGUAGES[langCode] || langCode);
    } else if (TRANSLATION_ENGINE === 'deepl' && DEEPL_API_KEY) {
      out = await translateDeepL(text, langCode);
    } else {
      // FREE (default): Google first, MyMemory fallback.
      try {
        out = await translateGoogleFree(text, langCode);
      } catch (e1) {
        out = await translateMyMemory(text, langCode);
      }
    }
  } catch (e) {
    console.error(`translate(${langCode}) error:`, e.message);
    return null;
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
  const hebrew = (msg.text || '').trim();
  if (hebrew.length < 1) return;

  const isFinal = !!msg.isFinal;
  const id = msg.id ?? 0;
  const seq = msg.seq ?? 0;

  session.lastActivity = Date.now();

  // Distinct languages currently requested by viewers.
  const wanted = new Set();
  for (const v of session.viewers) if (v.lang) wanted.add(v.lang);
  if (wanted.size === 0) return; // nobody watching

  const translations = {};
  await Promise.all(
    [...wanted].map(async (lang) => {
      translations[lang] = await translate(hebrew, lang);
    })
  );

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
  const engine = TRANSLATION_ENGINE === 'openai' && OPENAI_API_KEY ? `OpenAI(${TRANSLATE_MODEL})`
    : TRANSLATION_ENGINE === 'deepl' && DEEPL_API_KEY ? 'DeepL'
    : 'FREE (Google/MyMemory, no key)';
  console.log(`\nLive translation server on http://localhost:${PORT}`);
  console.log(`Source=${SOURCE_LANG}  Translate=${engine}  STT=browser (Web Speech API, free)\n`);
});
