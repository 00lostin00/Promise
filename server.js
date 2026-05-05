const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const VALID_USERS = {
  qsky: { displayName: "Qsky", color: "#a8b5a0", side: "left" },
  liutao: { displayName: "我爱刘涛", color: "#e8b4b8", side: "right" },
};

const sessions = new Map();
const clients = new Set();
const presence = new Map(); // username -> lastSeenAt (ISO string), in-memory only

function emptyStore() {
  return {
    version: 4,
    updatedAt: new Date().toISOString(),
    users: {},
    goals: {
      qsky: { paperTarget: 30, vocabTarget: 1000 },
      liutao: { paperTarget: 30, vocabTarget: 1000 },
    },
    checkins: [],
    papers: [],
    examAttempts: [],
    vocab: [],
    math: [],
    wrongQuestions: [],
    stickyNotes: [],
    dailySummaries: [],
    chatMessages: [],
    formulaNotes: [],
    flashcardReviews: [],
  };
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(emptyStore(), null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return { ...emptyStore(), ...raw };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  broadcast(store);
}

function publicState(store) {
  const { users, ...rest } = store;
  const safeUsers = {};
  for (const [k, v] of Object.entries(users || {})) {
    safeUsers[k] = {
      displayName: v.displayName,
      color: v.color,
      createdAt: v.createdAt,
      lastSeenAt: presence.get(k) || null,
    };
  }
  return { ...rest, users: safeUsers };
}

function broadcastPresence() {
  const data = {};
  for (const [k, v] of presence.entries()) data[k] = v;
  const payload = `event: presence\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.res.write(payload);
}

function cleanupOldChat(store) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = store.chatMessages.length;
  store.chatMessages = store.chatMessages.filter(
    (m) => new Date(m.createdAt).getTime() >= cutoff,
  );
  return store.chatMessages.length !== before;
}

function broadcast(store) {
  const payload = `event: state\ndata: ${JSON.stringify(publicState(store))}\n\n`;
  for (const client of clients) client.res.write(payload);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function newSession(username) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { username, createdAt: Date.now() });
  return sid;
}

function authUser(req) {
  const sid = req.headers["x-session"] || "";
  const sess = sessions.get(String(sid));
  if (!sess) return null;
  return sess.username;
}

function collectBody(req, maxBytes = 20_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function safeFilePath(urlPath, baseDir) {
  const requestPath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const fullPath = path.normalize(path.join(baseDir, requestPath));
  if (fullPath !== baseDir && !fullPath.startsWith(baseDir + path.sep)) return null;
  return fullPath;
}

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function archiveExpiredStickyNotes(state) {
  const today = todayKey();
  let changed = false;
  for (const note of state.stickyNotes) {
    if (!note.archived && note.date && note.date < today) {
      note.archived = true;
      note.archivedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

function saveImageFromBase64(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("Invalid image data URL");
  const mime = match[1];
  const ext = mime.split("/")[1].replace("+xml", "").replace("jpeg", "jpg");
  const buf = Buffer.from(match[2], "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("Image too large (max 8MB)");
  const name = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

function normalizeImages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === "string" && item.startsWith("/uploads/")) return item;
      if (typeof item === "string" && item.startsWith("data:image/")) {
        try { return saveImageFromBase64(item); } catch { return null; }
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizePaper(input) {
  const paper = Array.isArray(input) ? { title: "Imported Paper", questions: input } : input;
  if (!paper || typeof paper !== "object") throw new Error("Paper must be an object");

  const sections = Array.isArray(paper.sections)
    ? paper.sections
    : [{ title: paper.section || "Questions", questions: paper.questions || [] }];

  const questions = sections.flatMap((section, sIdx) =>
    (section.questions || []).map((q, qIdx) => ({
      id: String(q.id || `${sIdx + 1}-${qIdx + 1}`),
      section: section.title || `Section ${sIdx + 1}`,
      type: q.type || "short",
      prompt: q.prompt || q.question || q.stem || "",
      options: Array.isArray(q.options) ? q.options : [],
      images: normalizeImages(q.images),
      answer: q.answer ?? q.correctAnswer ?? q.key ?? "",
      note: q.note || q.explanation || "",
    })),
  );

  if (!questions.length) throw new Error("Paper needs at least one question");

  return {
    id: String(paper.id || id("paper")),
    title: paper.title || paper.name || "Untitled Paper",
    source: paper.source || "",
    tags: Array.isArray(paper.tags) ? paper.tags : [],
    createdAt: new Date().toISOString(),
    questions,
  };
}

function scoreAttempt(paper, answers) {
  const total = paper.questions.filter((q) => String(q.answer).trim()).length;
  if (!total) return { correct: 0, total: 0, percent: null, wrong: [] };
  const wrong = [];
  let correct = 0;
  for (const q of paper.questions) {
    const expected = String(q.answer).trim().toLowerCase();
    const actual = String(answers[q.id] || "").trim().toLowerCase();
    if (!expected) continue;
    if (actual === expected) correct++;
    else wrong.push({ questionId: q.id, prompt: q.prompt, yourAnswer: actual, correctAnswer: q.answer, note: q.note });
  }
  return { correct, total, percent: Math.round((correct / total) * 100), wrong };
}

async function handleAuth(req, res, pathname) {
  const body = await collectBody(req);

  if (pathname === "/api/login") {
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!VALID_USERS[username]) {
      return sendJson(res, 401, { error: "用户名不存在，仅允许 Qsky / 我爱刘涛" });
    }
    const store = readStore();
    if (!store.users[username]) {
      if (!password) return sendJson(res, 400, { error: "首次登录需要设置密码", needSetup: true });
      store.users[username] = {
        password,
        displayName: VALID_USERS[username].displayName,
        color: VALID_USERS[username].color,
        side: VALID_USERS[username].side,
        createdAt: new Date().toISOString(),
      };
      writeStore(store);
      const sid = newSession(username);
      return sendJson(res, 200, { sessionId: sid, username, firstLogin: true });
    }
    if (store.users[username].password !== password) {
      return sendJson(res, 401, { error: "密码错误" });
    }
    const sid = newSession(username);
    return sendJson(res, 200, { sessionId: sid, username });
  }

  if (pathname === "/api/check-user") {
    const username = String(body.username || "").trim().toLowerCase();
    if (!VALID_USERS[username]) return sendJson(res, 404, { error: "用户名不存在" });
    const store = readStore();
    return sendJson(res, 200, {
      username,
      displayName: VALID_USERS[username].displayName,
      needSetup: !store.users[username],
    });
  }

  if (pathname === "/api/logout") {
    const sid = req.headers["x-session"] || "";
    sessions.delete(String(sid));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function handleApi(req, res, pathname) {
  if (req.method === "POST" && (pathname === "/api/login" || pathname === "/api/check-user" || pathname === "/api/logout")) {
    return handleAuth(req, res, pathname);
  }

  if (req.method === "GET" && pathname === "/api/state") {
    const store = readStore();
    if (archiveExpiredStickyNotes(store)) writeStore(store);
    return sendJson(res, 200, publicState(store));
  }

  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const client = { res };
    clients.add(client);
    const store = readStore();
    res.write(`event: state\ndata: ${JSON.stringify(publicState(store))}\n\n`);
    const presenceData = {};
    for (const [k, v] of presence.entries()) presenceData[k] = v;
    res.write(`event: presence\ndata: ${JSON.stringify(presenceData)}\n\n`);
    req.on("close", () => clients.delete(client));
    return;
  }

  const username = authUser(req);
  if (!username) return sendJson(res, 401, { error: "未登录或会话已过期" });

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  try {
    const body = await collectBody(req);
    const store = readStore();
    archiveExpiredStickyNotes(store);

    if (pathname === "/api/upload") {
      const url = saveImageFromBase64(body.dataUrl);
      return sendJson(res, 201, { url });
    }

    if (pathname === "/api/password") {
      const oldPwd = String(body.oldPassword || "");
      const newPwd = String(body.newPassword || "");
      if (!newPwd) return sendJson(res, 400, { error: "新密码不能为空" });
      if (store.users[username].password !== oldPwd) return sendJson(res, 401, { error: "原密码错误" });
      store.users[username].password = newPwd;
      writeStore(store);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/checkins") {
      const images = normalizeImages(body.images);
      const entry = {
        id: id("ci"),
        owner: username,
        subject: String(body.subject || "general").slice(0, 32),
        type: String(body.type || "study").slice(0, 32),
        title: String(body.title || "打卡").slice(0, 200),
        amount: Number(body.amount || 0),
        unit: String(body.unit || "min").slice(0, 20),
        markdown: String(body.markdown || body.note || "").slice(0, 8000),
        images,
        createdAt: new Date().toISOString(),
      };
      store.checkins.unshift(entry);
      writeStore(store);
      return sendJson(res, 201, { entry, state: publicState(store) });
    }

    if (pathname === "/api/checkins/delete") {
      const targetId = String(body.id || "");
      const before = store.checkins.length;
      store.checkins = store.checkins.filter((c) => !(c.id === targetId && c.owner === username));
      if (store.checkins.length === before) return sendJson(res, 404, { error: "未找到或无权删除" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    if (pathname === "/api/papers") {
      const paper = normalizePaper(body.paper || body);
      paper.owner = username;
      const idx = store.papers.findIndex((p) => p.id === paper.id);
      if (idx >= 0) store.papers[idx] = paper;
      else store.papers.unshift(paper);
      writeStore(store);
      return sendJson(res, 201, { state: publicState(store) });
    }

    if (pathname === "/api/papers/delete") {
      const pid = String(body.id || "");
      const paper = store.papers.find((p) => p.id === pid);
      if (!paper) return sendJson(res, 404, { error: "Paper not found" });
      store.papers = store.papers.filter((p) => p.id !== pid);
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    if (pathname === "/api/exam-attempts") {
      const paper = store.papers.find((p) => p.id === body.paperId);
      if (!paper) return sendJson(res, 404, { error: "Paper not found" });
      const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
      const score = scoreAttempt(paper, answers);
      const images = normalizeImages(body.images);
      const attempt = {
        id: id("att"),
        paperId: paper.id,
        paperTitle: paper.title,
        owner: username,
        duration: Number(body.duration || 0),
        answers,
        score,
        markdown: String(body.markdown || "").slice(0, 8000),
        images,
        createdAt: new Date().toISOString(),
      };
      store.examAttempts.unshift(attempt);
      // 自动汇入错题本
      for (const w of score.wrong) {
        store.wrongQuestions.unshift({
          id: id("wq"),
          owner: username,
          source: "paper",
          paperId: paper.id,
          paperTitle: paper.title,
          questionId: w.questionId,
          prompt: w.prompt,
          yourAnswer: w.yourAnswer,
          correctAnswer: w.correctAnswer,
          note: w.note || "",
          subject: "english",
          images: [],
          mastered: false,
          createdAt: new Date().toISOString(),
        });
      }
      // 自动加打卡
      store.checkins.unshift({
        id: id("ci"),
        owner: username,
        subject: "english",
        type: "paper",
        title: `卷子: ${paper.title}`,
        amount: Number(body.duration || 0),
        unit: "min",
        markdown: `得分 ${score.correct}/${score.total}${score.percent !== null ? ` (${score.percent}%)` : ""}`,
        images,
        relatedId: attempt.id,
        relatedType: "examAttempt",
        createdAt: new Date().toISOString(),
      });
      writeStore(store);
      return sendJson(res, 201, { attempt, state: publicState(store) });
    }

    if (pathname === "/api/vocab") {
      const word = String(body.word || "").trim();
      if (!word) return sendJson(res, 400, { error: "单词不能为空" });
      const existing = store.vocab.find(
        (v) => v.owner === username && v.word.toLowerCase() === word.toLowerCase(),
      );
      const images = normalizeImages(body.images);
      const entry = {
        id: existing?.id || id("voc"),
        owner: username,
        word,
        meaning: String(body.meaning || existing?.meaning || "").slice(0, 400),
        status: String(body.status || "learning"),
        reviews: Number(existing?.reviews || 0) + 1,
        markdown: String(body.markdown || existing?.markdown || "").slice(0, 4000),
        images: images.length ? images : existing?.images || [],
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, entry);
      else store.vocab.unshift(entry);
      // 打卡
      store.checkins.unshift({
        id: id("ci"),
        owner: username,
        subject: "english",
        type: "vocab",
        title: `单词: ${word}`,
        amount: 1,
        unit: "个",
        markdown: entry.meaning,
        images: entry.images.slice(),
        relatedId: entry.id,
        relatedType: "vocab",
        createdAt: new Date().toISOString(),
      });
      writeStore(store);
      return sendJson(res, 201, { entry, state: publicState(store) });
    }

    if (pathname === "/api/vocab/delete") {
      const vid = String(body.id || "");
      const before = store.vocab.length;
      store.vocab = store.vocab.filter((v) => !(v.id === vid && v.owner === username));
      if (store.vocab.length === before) return sendJson(res, 404, { error: "未找到" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    if (pathname === "/api/math") {
      const images = normalizeImages(body.images);
      if (body.id) {
        const m = store.math.find((x) => x.id === body.id && x.owner === username);
        if (!m) return sendJson(res, 404, { error: "未找到" });
        Object.assign(m, {
          topic: String(body.topic || m.topic).slice(0, 60),
          title: String(body.title || m.title).slice(0, 200),
          status: String(body.status || m.status),
          markdown: String(body.markdown || "").slice(0, 8000),
          images: images.length ? images : m.images || [],
          updatedAt: new Date().toISOString(),
        });
        writeStore(store);
        return sendJson(res, 200, { state: publicState(store) });
      }
      const entry = {
        id: id("math"),
        owner: username,
        topic: String(body.topic || "mixed").slice(0, 60),
        title: String(body.title || "数学题").slice(0, 200),
        status: String(body.status || "todo"),
        markdown: String(body.markdown || "").slice(0, 8000),
        images,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.math.unshift(entry);
      store.checkins.unshift({
        id: id("ci"),
        owner: username,
        subject: "math",
        type: "math",
        title: `数学: ${entry.title}`,
        amount: 1,
        unit: "题",
        markdown: entry.markdown,
        images: entry.images.slice(),
        relatedId: entry.id,
        relatedType: "math",
        createdAt: new Date().toISOString(),
      });
      writeStore(store);
      return sendJson(res, 201, { entry, state: publicState(store) });
    }

    if (pathname === "/api/math/delete") {
      const mid = String(body.id || "");
      const before = store.math.length;
      store.math = store.math.filter((m) => !(m.id === mid && m.owner === username));
      if (store.math.length === before) return sendJson(res, 404, { error: "未找到" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    if (pathname === "/api/wrong-questions") {
      const images = normalizeImages(body.images);
      if (body.id) {
        const w = store.wrongQuestions.find((x) => x.id === body.id && x.owner === username);
        if (!w) return sendJson(res, 404, { error: "未找到" });
        Object.assign(w, {
          prompt: String(body.prompt || w.prompt).slice(0, 2000),
          yourAnswer: String(body.yourAnswer || w.yourAnswer || ""),
          correctAnswer: String(body.correctAnswer || w.correctAnswer || ""),
          note: String(body.note || "").slice(0, 4000),
          mastered: Boolean(body.mastered),
          images: images.length ? images : w.images || [],
          subject: String(body.subject || w.subject),
          updatedAt: new Date().toISOString(),
        });
        writeStore(store);
        return sendJson(res, 200, { state: publicState(store) });
      }
      const entry = {
        id: id("wq"),
        owner: username,
        source: "manual",
        subject: String(body.subject || "english"),
        prompt: String(body.prompt || "").slice(0, 2000),
        yourAnswer: String(body.yourAnswer || ""),
        correctAnswer: String(body.correctAnswer || ""),
        note: String(body.note || "").slice(0, 4000),
        mastered: false,
        images,
        createdAt: new Date().toISOString(),
      };
      store.wrongQuestions.unshift(entry);
      store.checkins.unshift({
        id: id("ci"),
        owner: username,
        subject: entry.subject,
        type: "wrong",
        title: `错题: ${(entry.prompt || "").slice(0, 40) || "未命名"}`,
        amount: 1,
        unit: "题",
        markdown: entry.note,
        images: entry.images.slice(),
        relatedId: entry.id,
        relatedType: "wrong",
        createdAt: new Date().toISOString(),
      });
      writeStore(store);
      return sendJson(res, 201, { entry, state: publicState(store) });
    }

    if (pathname === "/api/wrong-questions/delete") {
      const wid = String(body.id || "");
      const before = store.wrongQuestions.length;
      store.wrongQuestions = store.wrongQuestions.filter(
        (w) => !(w.id === wid && w.owner === username),
      );
      if (store.wrongQuestions.length === before) return sendJson(res, 404, { error: "未找到" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    if (pathname === "/api/sticky-notes") {
      const images = normalizeImages(body.images);
      if (body.id) {
        const note = store.stickyNotes.find((n) => n.id === body.id && n.owner === username);
        if (!note) return sendJson(res, 404, { error: "未找到" });
        if (typeof body.markdown === "string") note.markdown = body.markdown.slice(0, 8000);
        if (images.length) note.images = images;
        if (typeof body.title === "string") note.title = body.title.slice(0, 100);
        if (typeof body.color === "string") note.color = body.color.slice(0, 16);
        if (typeof body.order === "number") note.order = body.order;
        note.updatedAt = new Date().toISOString();
        writeStore(store);
        return sendJson(res, 200, { state: publicState(store) });
      }
      const entry = {
        id: id("note"),
        owner: username,
        date: String(body.date || todayKey()),
        title: String(body.title || "便利贴").slice(0, 100),
        markdown: String(body.markdown || "").slice(0, 8000),
        color: String(body.color || "yellow").slice(0, 16),
        images,
        order: Number(body.order || 0),
        archived: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.stickyNotes.unshift(entry);
      writeStore(store);
      return sendJson(res, 201, { entry, state: publicState(store) });
    }

    if (pathname === "/api/sticky-notes/delete") {
      const nid = String(body.id || "");
      const before = store.stickyNotes.length;
      store.stickyNotes = store.stickyNotes.filter(
        (n) => !(n.id === nid && n.owner === username),
      );
      if (store.stickyNotes.length === before) return sendJson(res, 404, { error: "未找到" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    if (pathname === "/api/daily-summaries") {
      const date = String(body.date || todayKey());
      const images = normalizeImages(body.images);
      const existing = store.dailySummaries.find(
        (s) => s.owner === username && s.date === date,
      );
      if (existing) {
        existing.markdown = String(body.markdown || "").slice(0, 16000);
        if (images.length) existing.images = images;
        existing.updatedAt = new Date().toISOString();
        writeStore(store);
        return sendJson(res, 200, { entry: existing, state: publicState(store) });
      }
      const entry = {
        id: id("sum"),
        owner: username,
        date,
        markdown: String(body.markdown || "").slice(0, 16000),
        images,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.dailySummaries.unshift(entry);
      store.checkins.unshift({
        id: id("ci"),
        owner: username,
        subject: "general",
        type: "summary",
        title: `每日总结 · ${date}`,
        amount: 0,
        unit: "",
        markdown: entry.markdown.slice(0, 200),
        images: entry.images.slice(),
        relatedId: entry.id,
        relatedType: "summary",
        createdAt: new Date().toISOString(),
      });
      writeStore(store);
      return sendJson(res, 201, { entry, state: publicState(store) });
    }

    if (pathname === "/api/goals") {
      if (!store.goals[username]) store.goals[username] = { paperTarget: 30, vocabTarget: 1000 };
      if (typeof body.paperTarget === "number") {
        store.goals[username].paperTarget = Math.max(0, body.paperTarget | 0);
      }
      if (typeof body.vocabTarget === "number") {
        store.goals[username].vocabTarget = Math.max(0, body.vocabTarget | 0);
      }
      store.goals[username].updatedAt = new Date().toISOString();
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    /* ---------- 聊天 ---------- */
    if (pathname === "/api/chat") {
      const text = String(body.text || "").slice(0, 2000);
      const images = normalizeImages(body.images);
      const quote = body.quote && typeof body.quote === "object"
        ? {
            id: String(body.quote.id || ""),
            type: String(body.quote.type || "checkin"),
            title: String(body.quote.title || "").slice(0, 120),
            owner: String(body.quote.owner || ""),
          }
        : null;
      if (!text && !images.length && !quote) {
        return sendJson(res, 400, { error: "消息不能为空" });
      }
      const msg = {
        id: id("msg"),
        from: username,
        text,
        images,
        quote,
        createdAt: new Date().toISOString(),
      };
      store.chatMessages.push(msg);
      cleanupOldChat(store);
      writeStore(store);
      return sendJson(res, 201, { message: msg, state: publicState(store) });
    }

    if (pathname === "/api/chat/delete") {
      const mid = String(body.id || "");
      const before = store.chatMessages.length;
      store.chatMessages = store.chatMessages.filter(
        (m) => !(m.id === mid && m.from === username),
      );
      if (store.chatMessages.length === before) return sendJson(res, 404, { error: "未找到" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    /* ---------- 心跳（在线状态，仅内存） ---------- */
    if (pathname === "/api/heartbeat") {
      presence.set(username, new Date().toISOString());
      broadcastPresence();
      return sendJson(res, 200, { ok: true, t: Date.now() });
    }

    /* ---------- 闪卡（艾宾浩斯：1/3/7/15 天） ---------- */
    if (pathname === "/api/flashcard/review") {
      const wordId = String(body.wordId || "");
      const result = String(body.result || "again"); // again / good
      const word = store.vocab.find((v) => v.id === wordId && v.owner === username);
      if (!word) return sendJson(res, 404, { error: "未找到单词" });
      const review = {
        id: id("fc"),
        owner: username,
        wordId,
        word: word.word,
        result,
        createdAt: new Date().toISOString(),
      };
      store.flashcardReviews.unshift(review);
      // 简化艾宾浩斯：连续答对推进 stage（0→1→2→3→4），答错回 0
      const stage = Number(word.stage || 0);
      const newStage = result === "good" ? Math.min(4, stage + 1) : 0;
      const intervals = [1, 1, 3, 7, 15]; // 天数
      const next = new Date();
      next.setDate(next.getDate() + intervals[newStage]);
      word.stage = newStage;
      word.nextReviewAt = next.toISOString();
      word.lastReviewAt = new Date().toISOString();
      word.reviews = (Number(word.reviews) || 0) + 1;
      if (newStage === 4) word.status = "mastered";
      else if (result === "again") word.status = "again";
      else word.status = "learning";
      writeStore(store);
      return sendJson(res, 201, { word, state: publicState(store) });
    }

    /* ---------- 公式笔记（数学专项） ---------- */
    if (pathname === "/api/formula-notes") {
      const images = normalizeImages(body.images);
      if (body.id) {
        const n = store.formulaNotes.find((x) => x.id === body.id && x.owner === username);
        if (!n) return sendJson(res, 404, { error: "未找到" });
        Object.assign(n, {
          title: String(body.title || n.title).slice(0, 120),
          tag: String(body.tag || n.tag || "综合").slice(0, 30),
          markdown: String(body.markdown || "").slice(0, 16000),
          images: images.length ? images : n.images || [],
          updatedAt: new Date().toISOString(),
        });
        writeStore(store);
        return sendJson(res, 200, { state: publicState(store) });
      }
      const note = {
        id: id("fn"),
        owner: username,
        title: String(body.title || "公式笔记").slice(0, 120),
        tag: String(body.tag || "综合").slice(0, 30),
        markdown: String(body.markdown || "").slice(0, 16000),
        images,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.formulaNotes.unshift(note);
      writeStore(store);
      return sendJson(res, 201, { note, state: publicState(store) });
    }

    if (pathname === "/api/formula-notes/delete") {
      const fid = String(body.id || "");
      const before = store.formulaNotes.length;
      store.formulaNotes = store.formulaNotes.filter(
        (n) => !(n.id === fid && n.owner === username),
      );
      if (store.formulaNotes.length === before) return sendJson(res, 404, { error: "未找到" });
      writeStore(store);
      return sendJson(res, 200, { state: publicState(store) });
    }

    /* ---------- 数据导出 ---------- */
    if (pathname === "/api/export") {
      const exportData = { ...publicState(store), exportedAt: new Date().toISOString() };
      return sendJson(res, 200, exportData);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function handleStatic(req, res, pathname) {
  if (pathname.startsWith("/uploads/")) {
    const fullPath = safeFilePath(pathname.replace(/^\/uploads/, "/"), UPLOAD_DIR);
    if (!fullPath || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(fullPath).toLowerCase();
    const types = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    return fs.createReadStream(fullPath).pipe(res);
  }

  const fullPath = safeFilePath(pathname, PUBLIC_DIR);
  if (!fullPath || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const ext = path.extname(fullPath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "Server error" });
    });
  } else {
    handleStatic(req, res, url.pathname);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const nets = require("os").networkInterfaces();
  const addresses = Object.values(nets)
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}`);
  console.log(`Promise running at http://localhost:${PORT}`);
  if (addresses.length) console.log(`LAN: ${addresses.join("  ")}`);
});

module.exports = server;
