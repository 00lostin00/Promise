/* Promise · 双人学习打卡（Qsky / 我爱刘涛）
 * - 仅两个用户，用户名 + 密码登录（首次设密码）
 * - 左右分屏，底部全局时间线（CF 风格）
 * - 模块：单词 / 卷子 / 错题 / 数学 / 便利贴 / 结束总结 / 进度条
 * - Markdown 渲染（GFM 任务列表可勾选）+ 图片粘贴/拖拽/上传
 */

const { createApp, reactive, computed, onMounted, onBeforeUnmount, ref, watch, nextTick } = Vue;

const STORAGE = {
  session: "promise-session-id",
  username: "promise-username",
};

const USERS = {
  qsky: { displayName: "Qsky", color: "#a8b5a0", side: "left", colorSoft: "#dce4d3" },
  liutao: { displayName: "我爱刘涛", color: "#e8b4b8", side: "right", colorSoft: "#f4d8da" },
};

const ALL_USERNAMES = ["qsky", "liutao"];

const SUBJECT_LABEL = {
  english: "英语",
  math: "数学",
  general: "通用",
};
const TYPE_LABEL = {
  study: "学习",
  paper: "卷子",
  vocab: "单词",
  wrong: "错题",
  math: "数学",
  summary: "总结",
  note: "便利贴",
};

/* -------------------- 工具函数 -------------------- */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* -------------------- 轻量 Markdown 渲染（含 GFM 任务勾选） -------------------- */
function renderMarkdown(md, opts = {}) {
  if (!md) return "";
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let taskIndex = 0;

  function inlineFmt(text) {
    let s = escapeHtml(text);
    // 行内代码
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 加粗
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 斜体
    s = s.replace(/(^|[\s_])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    // 图片 ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
    return s;
  }

  while (i < lines.length) {
    const line = lines[i];
    // 代码块
    if (/^```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inlineFmt(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // 引用
    if (/^>\s?/.test(line)) {
      out.push(`<blockquote>${inlineFmt(line.replace(/^>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }
    // 任务列表 / 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        let raw = lines[i].replace(/^\s*[-*+]\s+/, "");
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(raw);
        if (taskMatch) {
          const checked = taskMatch[1].toLowerCase() === "x";
          const idx = taskIndex++;
          items.push(
            `<li class="task ${checked ? "done" : ""}"><label><input type="checkbox" data-task-index="${idx}" ${checked ? "checked" : ""} ${opts.editable ? "" : "disabled"}/> <span>${inlineFmt(taskMatch[2])}</span></label></li>`,
          );
        } else {
          items.push(`<li>${inlineFmt(raw)}</li>`);
        }
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    // 数字列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inlineFmt(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    // 空行
    if (!line.trim()) { i++; continue; }
    // 段落（合并连续非空行）
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|>\s|```|[-*+]\s|\d+\.\s)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineFmt(buf.join("\n").replace(/\n/g, "<br/>"))}</p>`);
  }
  return out.join("\n");
}

/** 切换 markdown 中第 N 个任务复选框的勾选状态 */
function toggleTaskCheckbox(md, taskIndex) {
  let n = -1;
  return String(md).replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (m, prefix, mark) => {
    n++;
    if (n !== taskIndex) return m;
    const next = mark.toLowerCase() === "x" ? " " : "x";
    return `${prefix}[${next}]`;
  });
}

/* -------------------- API 客户端 -------------------- */
const api = {
  session() {
    return localStorage.getItem(STORAGE.session) || "";
  },
  setSession(sid, username) {
    if (sid) localStorage.setItem(STORAGE.session, sid);
    else localStorage.removeItem(STORAGE.session);
    if (username) localStorage.setItem(STORAGE.username, username);
    else localStorage.removeItem(STORAGE.username);
  },
  async request(path, body) {
    const opts = {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session": this.session(),
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  state() { return this.request("/api/state"); },
  login(username, password) { return this.request("/api/login", { username, password }); },
  checkUser(username) { return this.request("/api/check-user", { username }); },
  logout() { return this.request("/api/logout", {}); },
  upload(dataUrl) { return this.request("/api/upload", { dataUrl }); },
  changePassword(oldPwd, newPwd) {
    return this.request("/api/password", { oldPassword: oldPwd, newPassword: newPwd });
  },
  addCheckin(payload) { return this.request("/api/checkins", payload); },
  delCheckin(id) { return this.request("/api/checkins/delete", { id }); },
  addPaper(paper) { return this.request("/api/papers", { paper }); },
  delPaper(id) { return this.request("/api/papers/delete", { id }); },
  submitExam(payload) { return this.request("/api/exam-attempts", payload); },
  addVocab(payload) { return this.request("/api/vocab", payload); },
  delVocab(id) { return this.request("/api/vocab/delete", { id }); },
  upsertMath(payload) { return this.request("/api/math", payload); },
  delMath(id) { return this.request("/api/math/delete", { id }); },
  upsertWrong(payload) { return this.request("/api/wrong-questions", payload); },
  delWrong(id) { return this.request("/api/wrong-questions/delete", { id }); },
  upsertNote(payload) { return this.request("/api/sticky-notes", payload); },
  delNote(id) { return this.request("/api/sticky-notes/delete", { id }); },
  upsertSummary(payload) { return this.request("/api/daily-summaries", payload); },
  setGoals(payload) { return this.request("/api/goals", payload); },
  sendChat(payload) { return this.request("/api/chat", payload); },
  delChat(id) { return this.request("/api/chat/delete", { id }); },
  heartbeat() { return this.request("/api/heartbeat", {}); },
  reviewCard(wordId, result) { return this.request("/api/flashcard/review", { wordId, result }); },
  upsertFormula(payload) { return this.request("/api/formula-notes", payload); },
  delFormula(id) { return this.request("/api/formula-notes/delete", { id }); },
  exportAll() { return this.request("/api/export", {}); },
};

/* -------------------- 图片处理（粘贴 / 拖拽 / 上传） -------------------- */
async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function uploadFiles(files) {
  const urls = [];
  for (const file of files) {
    if (!file.type || !file.type.startsWith("image/")) continue;
    const dataUrl = await fileToDataUrl(file);
    const res = await api.upload(dataUrl);
    urls.push(res.url);
  }
  return urls;
}

/* -------------------- 应用主体 -------------------- */
const app = createApp({
  setup() {
    const state = reactive({
      users: {},
      goals: { qsky: { paperTarget: 30, vocabTarget: 1000 }, liutao: { paperTarget: 30, vocabTarget: 1000 } },
      checkins: [], papers: [], examAttempts: [],
      vocab: [], math: [], wrongQuestions: [],
      stickyNotes: [], dailySummaries: [],
      chatMessages: [], formulaNotes: [], flashcardReviews: [],
    });
    const presenceMap = reactive({});  // username -> ISO lastSeenAt
    const nowTick = ref(Date.now());   // 每 10s 跳一次，让"刚刚在线"等文案重算

    const me = ref(localStorage.getItem(STORAGE.username) || "");
    const loginUsername = ref("");
    const loginPassword = ref("");
    const loginConfirm = ref("");
    const loginNeedSetup = ref(false);
    const loginError = ref("");
    const booted = ref(false);
    const toast = ref("");

    /* 模块切换：左右两侧各自维护当前 tab */
    const tabs = reactive({ qsky: "note", liutao: "note" });
    const TAB_LIST = [
      { id: "note", label: "便利贴", icon: "🗒" },
      { id: "vocab", label: "单词", icon: "📚" },
      { id: "paper", label: "卷子", icon: "📝" },
      { id: "wrong", label: "错题", icon: "❌" },
      { id: "math", label: "数学", icon: "🧮" },
      { id: "summary", label: "总结", icon: "🌙" },
    ];

    /* 弹窗 */
    const detailModal = reactive({ open: false, type: "", entry: null });
    const editModal = reactive({ open: false, type: "", form: null });
    const englishHub = reactive({ open: false, tab: "vocab" });
    const mathHub = reactive({ open: false, tab: "topics" });
    const chatDrawer = reactive({ open: false, draft: "", images: [], quote: null, lastReadAt: 0 });
    const flashcardSession = reactive({ open: false, queue: [], idx: 0, showBack: false });
    const statsModal = reactive({ open: false });

    function showToast(msg) {
      toast.value = msg;
      setTimeout(() => { if (toast.value === msg) toast.value = ""; }, 2200);
    }

    /* ---------- 登录流程 ---------- */
    async function handleLoginNameBlur() {
      loginError.value = "";
      const name = loginUsername.value.trim().toLowerCase();
      if (!USERS[mapDisplayToKey(loginUsername.value)] && !USERS[name]) {
        loginNeedSetup.value = false;
        return;
      }
      const key = USERS[name] ? name : mapDisplayToKey(loginUsername.value);
      try {
        const res = await api.checkUser(key);
        loginNeedSetup.value = !!res.needSetup;
      } catch {
        loginNeedSetup.value = false;
      }
    }

    function mapDisplayToKey(input) {
      const v = String(input || "").trim();
      if (!v) return "";
      if (v.toLowerCase() === "qsky") return "qsky";
      if (v === "我爱刘涛" || v.toLowerCase() === "liutao") return "liutao";
      return "";
    }

    /* ---------- 闪卡 / 聊天 / 工作台 ---------- */
    function todayDueWords(owner) {
      const now = Date.now();
      return state.vocab.filter((v) => {
        if (v.owner !== owner) return false;
        if (v.status === "mastered" && v.stage >= 4) return false;
        if (!v.nextReviewAt) return true;
        return new Date(v.nextReviewAt).getTime() <= now;
      });
    }
    function startFlashcards() {
      const queue = todayDueWords(me.value).slice().sort(() => Math.random() - 0.5);
      if (!queue.length) {
        showToast("今天没有要复习的词 ✨");
        return;
      }
      flashcardSession.queue = queue;
      flashcardSession.idx = 0;
      flashcardSession.showBack = false;
      flashcardSession.open = true;
    }
    async function answerCard(result) {
      const card = flashcardSession.queue[flashcardSession.idx];
      if (!card) return;
      try { await api.reviewCard(card.id, result); } catch (err) { showToast(err.message); }
      flashcardSession.showBack = false;
      if (flashcardSession.idx + 1 >= flashcardSession.queue.length) {
        flashcardSession.open = false;
        showToast(`完成 ${flashcardSession.queue.length} 张卡 🎉`);
      } else {
        flashcardSession.idx++;
      }
    }

    /* 聊天未读数 */
    const unreadChat = computed(() => {
      const last = chatDrawer.lastReadAt || 0;
      return state.chatMessages.filter(
        (m) => m.from !== me.value && new Date(m.createdAt).getTime() > last,
      ).length;
    });
    function openChat() {
      chatDrawer.open = true;
      chatDrawer.lastReadAt = Date.now();
    }
    async function sendChat() {
      const text = (chatDrawer.draft || "").trim();
      if (!text && !chatDrawer.images.length && !chatDrawer.quote) return;
      try {
        await api.sendChat({
          text,
          images: chatDrawer.images.slice(),
          quote: chatDrawer.quote,
        });
        chatDrawer.draft = "";
        chatDrawer.images = [];
        chatDrawer.quote = null;
        chatDrawer.lastReadAt = Date.now();
      } catch (err) { showToast(err.message); }
    }
    async function pasteChatImages(evt) {
      const items = evt.clipboardData && evt.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) if (it.kind === "file") files.push(it.getAsFile());
      if (!files.length) return;
      evt.preventDefault();
      try {
        const urls = await uploadFiles(files);
        chatDrawer.images.push(...urls);
      } catch (err) { showToast(err.message); }
    }
    async function chooseChatImage(evt) {
      const files = Array.from(evt.target.files || []);
      evt.target.value = "";
      if (!files.length) return;
      try {
        const urls = await uploadFiles(files);
        chatDrawer.images.push(...urls);
      } catch (err) { showToast(err.message); }
    }
    function quoteCheckin(ci) {
      chatDrawer.quote = {
        id: ci.id,
        type: "checkin",
        title: ci.title,
        owner: ci.owner,
      };
      chatDrawer.open = true;
    }

    const globalSearch = reactive({ open: false, query: "" });
    const searchResults = computed(() => {
      const q = globalSearch.query.trim().toLowerCase();
      if (!q) return [];
      const hit = (...parts) => parts.some((part) => String(part || "").toLowerCase().includes(q));
      const rows = [];
      for (const v of state.vocab) {
        if (hit(v.word, v.meaning, v.markdown)) {
          rows.push({ type: "单词", title: v.word, sub: v.meaning || "无释义", detailType: "vocab", entry: v });
        }
      }
      for (const c of state.checkins.filter((item) => item.type === "vocab")) {
        if (hit(c.title, c.markdown, c.amount, c.unit)) {
          rows.push({ type: "单词打卡", title: c.title, sub: `${c.amount || 0} ${c.unit || "个"}`, detailType: "checkin", entry: c });
        }
      }
      for (const p of state.papers) {
        if (hit(p.title, p.source, ...(p.tags || []))) {
          rows.push({ type: "卷子", title: p.title, sub: `${p.questions.length} 题`, paper: p });
        }
      }
      for (const n of state.stickyNotes) {
        if (hit(n.title, n.markdown, n.date)) {
          rows.push({ type: "便利贴", title: n.title, sub: n.date, detailType: "note", entry: n });
        }
      }
      for (const m of state.chatMessages) {
        if (hit(m.text, m.quote?.title)) {
          rows.push({ type: "聊天", title: m.text || m.quote?.title || "图片消息", sub: fmtTime(m.createdAt), chat: true });
        }
      }
      return rows.slice(0, 40);
    });
    function openGlobalSearch() {
      globalSearch.open = true;
      nextTick(() => document.querySelector(".global-search-input")?.focus());
    }
    function closeGlobalSearch() {
      globalSearch.open = false;
      globalSearch.query = "";
    }
    function openSearchResult(item) {
      closeGlobalSearch();
      if (item.detailType) openDetail(item.detailType, item.entry);
      else if (item.paper) {
        englishHub.open = true;
        englishHub.tab = "papers";
        showToast("已打开卷子列表");
      } else if (item.chat) openChat();
    }

    function handleKeyboard(evt) {
      const target = evt.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "k") {
        evt.preventDefault();
        openGlobalSearch();
        return;
      }
      if (typing || evt.altKey || evt.ctrlKey || evt.metaKey) return;
      const key = evt.key.toLowerCase();
      const idx = Number(key);
      if (idx >= 1 && idx <= TAB_LIST.length) {
        tabs[me.value] = TAB_LIST[idx - 1].id;
      } else if (key === "e") {
        englishHub.open = true;
      } else if (key === "m") {
        mathHub.open = true;
      } else if (key === "c") {
        openChat();
      } else if (key === "escape" && globalSearch.open) {
        closeGlobalSearch();
      }
    }

    /* 数据导出 */
    async function exportData() {
      try {
        const data = await api.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `promise-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);
        showToast("已导出");
      } catch (err) { showToast(err.message); }
    }

    /* 公式笔记 CRUD（简单弹编辑表单，复用 editModal） */
    function openFormulaEdit(note) {
      editModal.open = true;
      editModal.type = "formula";
      editModal.form = reactive({
        id: note?.id || "",
        title: note?.title || "",
        tag: note?.tag || "综合",
        markdown: note?.markdown || "",
        images: (note?.images || []).slice(),
      });
    }

    async function delFormula(id) {
      if (!confirm("删除？")) return;
      try {
        await api.delFormula(id);
        showToast("已删除");
      } catch (err) {
        showToast("删除失败：" + err.message);
      }
    }

    async function markWrongMastered(id) {
      const w = state.wrongQuestions.find((item) => item.id === id);
      if (!w) return;
      try {
        await api.upsertWrong({
          id: w.id,
          prompt: w.prompt,
          yourAnswer: w.yourAnswer,
          correctAnswer: w.correctAnswer,
          note: w.note,
          subject: w.subject,
          mastered: true,
          images: w.images || [],
        });
        showToast("已标记掌握");
      } catch (err) {
        showToast("标记失败：" + err.message);
      }
    }

    async function reorderNotes(notes) {
      try {
        for (let idx = 0; idx < notes.length; idx++) {
          await api.upsertNote({ id: notes[idx].id, order: idx });
        }
        showToast("顺序已保存");
      } catch (err) {
        showToast("排序失败：" + err.message);
      }
    }

    async function handleLogin() {
      loginError.value = "";
      const key = mapDisplayToKey(loginUsername.value);
      if (!key) {
        loginError.value = "用户名只允许 Qsky 或 我爱刘涛";
        return;
      }
      if (loginNeedSetup.value && loginPassword.value !== loginConfirm.value) {
        loginError.value = "两次密码输入不一致";
        return;
      }
      try {
        const res = await api.login(key, loginPassword.value);
        api.setSession(res.sessionId, res.username);
        me.value = res.username;
        loginPassword.value = "";
        loginConfirm.value = "";
        await loadState();
        connectSSE();
        startHeartbeat();
        if (res.firstLogin) showToast(`欢迎 ${USERS[key].displayName}，密码已设置 ✨`);
      } catch (err) {
        if (err.data && err.data.needSetup) {
          loginNeedSetup.value = true;
          loginError.value = "首次登录，请设置密码";
        } else {
          loginError.value = err.message;
        }
      }
    }

    async function logout() {
      try { await api.logout(); } catch {}
      stopHeartbeat();
      if (sse) { sse.close(); sse = null; }
      api.setSession("", "");
      me.value = "";
      loginPassword.value = "";
      loginConfirm.value = "";
      loginUsername.value = "";
    }

    /* ---------- 数据加载 / SSE ---------- */
    async function loadState() {
      try {
        const data = await api.state();
        Object.assign(state, data);
      } catch (err) {
        if (err.status === 401) await logout();
      }
    }

    let sse = null;
    function connectSSE() {
      if (sse) sse.close();
      sse = new EventSource("/api/events");
      sse.addEventListener("state", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          Object.assign(state, data);
        } catch {}
      });
      sse.addEventListener("presence", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          for (const k of Object.keys(presenceMap)) delete presenceMap[k];
          Object.assign(presenceMap, data);
        } catch {}
      });
      sse.onerror = () => {
        if (sse) { sse.close(); sse = null; }
        setTimeout(() => { if (me.value) connectSSE(); }, 3000);
      };
    }

    /* ---------- 心跳 + 在线状态计算 ---------- */
    let heartbeatTimer = null;
    let nowTickTimer = null;
    function startHeartbeat() {
      stopHeartbeat();
      const beat = () => api.heartbeat().catch(() => {});
      beat();
      heartbeatTimer = setInterval(beat, 20000);
      nowTickTimer = setInterval(() => { nowTick.value = Date.now(); }, 15000);
    }
    function stopHeartbeat() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (nowTickTimer) clearInterval(nowTickTimer);
      heartbeatTimer = nowTickTimer = null;
    }
    const presenceComputed = computed(() => {
      void nowTick.value;
      const out = {};
      for (const username of ALL_USERNAMES) {
        const last = presenceMap[username];
        if (!last) {
          out[username] = { status: "offline", text: "离线", since: null };
          continue;
        }
        const diff = Date.now() - new Date(last).getTime();
        if (diff < 60_000) out[username] = { status: "online", text: "在线", since: last };
        else if (diff < 5 * 60_000) out[username] = { status: "away", text: "刚走开", since: last };
        else {
          const m = Math.round(diff / 60_000);
          const h = Math.floor(m / 60);
          out[username] = { status: "offline", text: h > 0 ? `${h} 小时前在线` : `${m} 分钟前在线`, since: last };
        }
      }
      return out;
    });

    /* ---------- 列表过滤 ---------- */
    function listOf(field, owner) {
      return state[field].filter((x) => x.owner === owner);
    }

    /* ---------- 进度条计算 ---------- */
    function progress(owner) {
      const goals = state.goals[owner] || { paperTarget: 30, vocabTarget: 1000 };
      const paperDone = state.examAttempts.filter((a) => a.owner === owner).length;
      const vocabCheckinDone = state.checkins
        .filter((c) => c.owner === owner && c.type === "vocab")
        .reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
      const vocabDone = vocabCheckinDone || state.vocab.filter((v) => v.owner === owner && v.status === "mastered").length;
      return {
        paper: { done: paperDone, target: goals.paperTarget || 0, percent: goals.paperTarget ? Math.min(100, Math.round((paperDone / goals.paperTarget) * 100)) : 0 },
        vocab: { done: vocabDone, target: goals.vocabTarget || 0, percent: goals.vocabTarget ? Math.min(100, Math.round((vocabDone / goals.vocabTarget) * 100)) : 0 },
      };
    }

    /* ---------- 连续打卡天数 ---------- */
    function streak(owner) {
      const dates = new Set();
      for (const c of state.checkins) {
        if (c.owner !== owner) continue;
        dates.add(c.createdAt.slice(0, 10));
      }
      let count = 0;
      const d = new Date();
      while (true) {
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (dates.has(k)) { count++; d.setDate(d.getDate() - 1); }
        else break;
      }
      return count;
    }

    /* ---------- 今日对比 ---------- */
    const todayCompare = computed(() => {
      const today = todayKey();
      function count(owner) {
        return state.checkins.filter((c) => c.owner === owner && c.createdAt.slice(0, 10) === today).length;
      }
      return { qsky: count("qsky"), liutao: count("liutao") };
    });

    /* ---------- 时间线 ---------- */
    const timeline = computed(() => {
      return state.checkins
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 200);
    });

    /* ---------- 弹窗：详情 / 编辑 ---------- */
    function openDetail(type, entry) {
      detailModal.open = true;
      detailModal.type = type;
      detailModal.entry = entry;
    }
    function closeDetail() {
      detailModal.open = false;
      detailModal.entry = null;
    }

    function openEdit(type, initial = {}) {
      editModal.open = true;
      editModal.type = type;
      editModal.form = reactive({
        id: initial.id || "",
        title: initial.title || "",
        word: initial.word || "",
        meaning: initial.meaning || "",
        status: initial.status || (type === "vocab" ? "learning" : "todo"),
        markdown: initial.markdown || initial.note || "",
        images: (initial.images || []).slice(),
        topic: initial.topic || "mixed",
        prompt: initial.prompt || "",
        yourAnswer: initial.yourAnswer || "",
        correctAnswer: initial.correctAnswer || "",
        subject: initial.subject || (type === "math" ? "math" : "english"),
        date: initial.date || todayKey(),
        color: initial.color || "yellow",
        amount: initial.amount || 0,
        duration: initial.duration || initial.minutes || 0,
        unit: initial.unit || "min",
        type: initial.entryType || "study",
      });
    }
    function closeEdit() {
      editModal.open = false;
      editModal.form = null;
    }

    async function submitEdit() {
      const f = editModal.form;
      try {
        if (editModal.type === "vocab") {
          const count = Math.max(0, Number(f.amount) || 0);
          const minutes = Math.max(0, Number(f.duration) || 0);
          await api.addCheckin({
            subject: "english",
            type: "vocab",
            title: `单词学习 · ${count || 0} 个`,
            amount: count,
            unit: "个",
            markdown: [`用时：${minutes || 0} 分钟`, f.markdown || ""].filter(Boolean).join("\n\n"),
            images: f.images,
          });
        } else if (editModal.type === "math") {
          await api.upsertMath({
            id: f.id || undefined,
            title: f.title, topic: f.topic, status: f.status,
            markdown: f.markdown, images: f.images,
          });
        } else if (editModal.type === "wrong") {
          await api.upsertWrong({
            id: f.id || undefined,
            subject: f.subject, prompt: f.prompt,
            yourAnswer: f.yourAnswer, correctAnswer: f.correctAnswer,
            note: f.markdown, images: f.images,
          });
        } else if (editModal.type === "note") {
          await api.upsertNote({
            id: f.id || undefined,
            title: f.title, markdown: f.markdown,
            color: f.color, images: f.images, date: f.date,
          });
        } else if (editModal.type === "summary") {
          await api.upsertSummary({
            date: f.date, markdown: f.markdown, images: f.images,
          });
        } else if (editModal.type === "checkin") {
          await api.addCheckin({
            subject: f.subject, type: f.type, title: f.title,
            amount: Number(f.amount) || 0, unit: f.unit,
            markdown: f.markdown, images: f.images,
          });
        } else if (editModal.type === "formula") {
          await api.upsertFormula({
            id: f.id || undefined,
            title: f.title, tag: f.tag, markdown: f.markdown, images: f.images,
          });
        }
        closeEdit();
        showToast("已保存");
      } catch (err) {
        showToast("保存失败：" + err.message);
      }
    }

    /* ---------- 通用：粘贴/拖拽/选择图片到 form.images ---------- */
    async function handleFiles(form, files) {
      try {
        const urls = await uploadFiles(Array.from(files));
        form.images.push(...urls);
      } catch (err) {
        showToast("图片上传失败：" + err.message);
      }
    }
    function removeImage(form, idx) {
      form.images.splice(idx, 1);
    }

    /* ---------- 便利贴：勾选任务 ---------- */
    async function toggleNoteTask(note, taskIndex) {
      const newMd = toggleTaskCheckbox(note.markdown, taskIndex);
      try {
        await api.upsertNote({ id: note.id, markdown: newMd });
      } catch (err) {
        showToast("勾选失败：" + err.message);
      }
    }

    /* ---------- 进度条目标设定 ---------- */
    const goalEditor = reactive({ open: false, paperTarget: 0, vocabTarget: 0 });
    function openGoalEditor() {
      const g = state.goals[me.value] || { paperTarget: 30, vocabTarget: 1000 };
      goalEditor.paperTarget = g.paperTarget;
      goalEditor.vocabTarget = g.vocabTarget;
      goalEditor.open = true;
    }
    async function saveGoals() {
      try {
        await api.setGoals({
          paperTarget: Number(goalEditor.paperTarget) || 0,
          vocabTarget: Number(goalEditor.vocabTarget) || 0,
        });
        goalEditor.open = false;
        showToast("目标已更新");
      } catch (err) {
        showToast("失败：" + err.message);
      }
    }

    /* ---------- 卷子答题 ---------- */
    const examModal = reactive({ open: false, paper: null, answers: {}, startedAt: 0, summary: "", images: [] });
    function startExam(paper) {
      examModal.paper = paper;
      examModal.answers = {};
      examModal.summary = "";
      examModal.images = [];
      examModal.startedAt = Date.now();
      examModal.open = true;
    }
    function closeExam() {
      examModal.open = false;
      examModal.paper = null;
    }
    async function submitExam() {
      if (!examModal.paper) return;
      const duration = Math.round((Date.now() - examModal.startedAt) / 60000);
      try {
        const res = await api.submitExam({
          paperId: examModal.paper.id,
          answers: examModal.answers,
          duration,
          markdown: examModal.summary,
          images: examModal.images,
        });
        closeExam();
        showToast(`提交成功 · ${res.attempt.score.correct}/${res.attempt.score.total}`);
        openDetail("attempt", res.attempt);
      } catch (err) {
        showToast("提交失败：" + err.message);
      }
    }

    /* ---------- 卷子导入 ---------- */
    async function importPaperFromFile(input) {
      try {
        const files = Array.isArray(input) ? input : Array.from(input?.length !== undefined ? input : [input]).filter(Boolean);
        if (!files.length) return;
        if (files.every((file) => file.type && file.type.startsWith("image/"))) {
          const urls = await uploadFiles(files);
          const firstName = files[0].name ? files[0].name.replace(/\.[^.]+$/, "") : "";
          await api.addPaper({
            title: firstName || `图片卷子 ${todayKey()}`,
            source: "image",
            tags: ["图片卷子"],
            questions: urls.map((url, idx) => ({
              id: String(idx + 1),
              type: "image",
              prompt: `图片题 ${idx + 1}`,
              images: [url],
              answer: "",
            })),
          });
          showToast(`图片卷子已导入 · ${urls.length} 张`);
          return;
        }
        const file = files[0];
        const text = await file.text();
        const json = JSON.parse(text);
        await api.addPaper(json);
        showToast("JSON 卷子已导入");
      } catch (err) {
        showToast("导入失败：" + err.message);
      }
    }

    /* ---------- 删除 ---------- */
    async function delEntry(type, id) {
      if (!confirm("确定删除？")) return;
      try {
        if (type === "vocab") await api.delVocab(id);
        else if (type === "math") await api.delMath(id);
        else if (type === "wrong") await api.delWrong(id);
        else if (type === "note") await api.delNote(id);
        else if (type === "paper") await api.delPaper(id);
        else if (type === "checkin") await api.delCheckin(id);
        showToast("已删除");
      } catch (err) { showToast("删除失败：" + err.message); }
    }

    /* ---------- 修改密码 ---------- */
    const pwdEditor = reactive({ open: false, oldPwd: "", newPwd: "", confirm: "" });
    async function savePassword() {
      if (pwdEditor.newPwd !== pwdEditor.confirm) {
        return showToast("两次新密码不一致");
      }
      try {
        await api.changePassword(pwdEditor.oldPwd, pwdEditor.newPwd);
        pwdEditor.open = false;
        pwdEditor.oldPwd = pwdEditor.newPwd = pwdEditor.confirm = "";
        showToast("密码已修改");
      } catch (err) { showToast(err.message); }
    }

    /* ---------- 启动 ---------- */
    onMounted(async () => {
      window.addEventListener("keydown", handleKeyboard);
      if (api.session() && me.value) {
        try {
          await loadState();
          if (me.value) { connectSSE(); startHeartbeat(); }
        } catch {}
      }
      booted.value = true;
    });
    onBeforeUnmount(() => {
      window.removeEventListener("keydown", handleKeyboard);
      if (sse) sse.close();
      stopHeartbeat();
    });

    return {
      // state
      state, me, booted, toast,
      USERS, ALL_USERNAMES, SUBJECT_LABEL, TYPE_LABEL,
      uploadFiles, presenceComputed,
      englishHub, mathHub, chatDrawer, statsModal, flashcardSession,
      globalSearch, searchResults, openGlobalSearch, closeGlobalSearch, openSearchResult,
      unreadChat, openChat, sendChat, pasteChatImages, chooseChatImage, quoteCheckin,
      startFlashcards, answerCard, todayDueWords,
      openFormulaEdit, delFormula, markWrongMastered, reorderNotes,
      exportData,
      // login
      loginUsername, loginPassword, loginConfirm, loginNeedSetup, loginError,
      handleLogin, handleLoginNameBlur, logout,
      // tabs
      tabs, TAB_LIST,
      // computed
      timeline, todayCompare,
      // helpers
      listOf, progress, streak, fmtTime, fmtDate, todayKey, renderMarkdown,
      // detail / edit
      detailModal, openDetail, closeDetail,
      editModal, openEdit, closeEdit, submitEdit,
      handleFiles, removeImage,
      toggleNoteTask,
      // goals
      goalEditor, openGoalEditor, saveGoals,
      // exam
      examModal, startExam, closeExam, submitExam,
      importPaperFromFile,
      delEntry,
      // password
      pwdEditor, savePassword,
    };
  },

  template: `
    <div v-if="!booted" class="splash">加载中…</div>

    <!-- 登录页 -->
    <div v-else-if="!me" class="login-shell">
      <div class="login-card">
        <h1 class="login-title">Promise</h1>
        <p class="login-sub">仅限 Qsky / 我爱刘涛</p>
        <label class="field">
          <span>用户名</span>
          <input v-model="loginUsername" @blur="handleLoginNameBlur" placeholder="Qsky 或 我爱刘涛" autocomplete="username" />
        </label>
        <label class="field">
          <span>{{ loginNeedSetup ? '设置密码' : '密码' }}</span>
          <input v-model="loginPassword" type="password" :placeholder="loginNeedSetup ? '首次登录请设置' : ''" autocomplete="current-password" @keyup.enter="!loginNeedSetup && handleLogin()"/>
        </label>
        <label class="field" v-if="loginNeedSetup">
          <span>确认密码</span>
          <input v-model="loginConfirm" type="password" @keyup.enter="handleLogin"/>
        </label>
        <button class="btn primary" @click="handleLogin">{{ loginNeedSetup ? '设置并登录' : '登录' }}</button>
        <div v-if="loginError" class="login-error">{{ loginError }}</div>
        <p class="login-hint">首次登录会自动设置密码，没有"忘记密码"，请记牢。</p>
      </div>
    </div>

    <!-- 主界面 -->
    <div v-else class="layout">
      <!-- 顶栏 -->
      <header class="topbar">
        <div class="brand">📘 Promise · 双人</div>

        <div class="topbar-info">
          <div v-for="u in ALL_USERNAMES" :key="u" class="user-chip">
            <span class="dot" :class="'dot-' + presenceComputed[u].status"></span>
            <span class="me-tag" :style="{ background: USERS[u].color }">{{ USERS[u].displayName }}</span>
            <span class="presence-text">{{ presenceComputed[u].text }}</span>
          </div>
        </div>

        <div class="topbar-actions">
          <button class="btn primary" @click="englishHub.open = true">📚 英语工作台</button>
          <button class="btn primary" @click="mathHub.open = true">🧮 数学工作台</button>
          <button class="btn ghost chat-btn" @click="openChat">
            💬 聊天<span v-if="unreadChat" class="unread">{{ unreadChat }}</span>
          </button>
          <button class="btn ghost" @click="statsModal.open = true">📊 统计</button>
          <button class="btn ghost" @click="openGoalEditor">🎯 目标</button>
          <button class="btn ghost" @click="exportData">📤 导出</button>
          <button class="btn ghost" @click="pwdEditor.open = true">🔑</button>
          <button class="btn ghost" @click="logout">退出</button>
        </div>
      </header>

      <!-- 双栏主体 -->
      <main class="split">
        <user-pane
          v-for="username in ALL_USERNAMES"
          :key="username"
          :username="username"
          :is-me="username === me"
          :state="state"
          :tab="tabs[username]"
          :tab-list="TAB_LIST"
          :progress="progress(username)"
          :streak="streak(username)"
          :list-of="listOf"
          :on-tab="(t) => tabs[username] = t"
          :on-detail="openDetail"
          :on-edit="openEdit"
          :on-del="delEntry"
          :on-toggle-task="toggleNoteTask"
          :on-reorder-notes="reorderNotes"
          :on-start-exam="startExam"
          :on-import-paper="importPaperFromFile"
          :render-md="renderMarkdown"
          :fmt-time="fmtTime"
          :fmt-date="fmtDate"
          :today-key="todayKey"
          :users="USERS"
        />
      </main>

      <!-- 底部全局时间线 -->
      <footer class="timeline">
        <div class="timeline-head">
          <span class="t-title">📡 全局时间线</span>
          <span class="t-sub">两人合并 · 最近 200 条</span>
        </div>
        <div class="timeline-track">
          <div
            v-for="ci in timeline"
            :key="ci.id"
            class="t-card"
            :class="['side-' + USERS[ci.owner].side]"
            :style="{ borderColor: USERS[ci.owner].color }"
            @click="openDetail('checkin', ci)"
          >
            <div class="t-head">
              <span class="t-owner" :style="{ background: USERS[ci.owner].color }">{{ USERS[ci.owner].displayName }}</span>
              <span class="t-type">{{ TYPE_LABEL[ci.type] || ci.type }}</span>
            </div>
            <div class="t-title-row">{{ ci.title }}</div>
            <div class="t-meta">{{ fmtTime(ci.createdAt) }}</div>
            <div v-if="ci.images && ci.images.length" class="t-thumb">
              <img :src="ci.images[0]" alt="" loading="lazy" />
              <span v-if="ci.images.length > 1" class="t-thumb-count">+{{ ci.images.length - 1 }}</span>
            </div>
          </div>
          <div v-if="!timeline.length" class="t-empty">还没有打卡 · 写一笔吧 ✍️</div>
        </div>
      </footer>

      <!-- 详情弹窗 -->
      <div v-if="detailModal.open" class="modal" @click.self="closeDetail">
        <div class="modal-card detail-card">
          <button class="modal-close" @click="closeDetail">×</button>
          <detail-view
            :type="detailModal.type"
            :entry="detailModal.entry"
            :state="state"
            :users="USERS"
            :render-md="renderMarkdown"
            :fmt-time="fmtTime"
            @mark-mastered="markWrongMastered"
          />
        </div>
      </div>

      <!-- 编辑弹窗 -->
      <div v-if="editModal.open" class="modal" @click.self="closeEdit">
        <div class="modal-card edit-card">
          <button class="modal-close" @click="closeEdit">×</button>
          <edit-form
            :type="editModal.type"
            :form="editModal.form"
            :on-files="handleFiles"
            :on-remove="removeImage"
            :on-submit="submitEdit"
            :on-cancel="closeEdit"
            :render-md="renderMarkdown"
            :state="state"
            :me="me"
            :today-key="todayKey"
          />
        </div>
      </div>

      <!-- 目标编辑 -->
      <div v-if="goalEditor.open" class="modal" @click.self="goalEditor.open = false">
        <div class="modal-card goal-card">
          <button class="modal-close" @click="goalEditor.open = false">×</button>
          <h3>🎯 我的进度目标</h3>
          <label class="field">
            <span>卷子目标（套）</span>
            <input type="number" v-model.number="goalEditor.paperTarget" min="0" />
          </label>
          <label class="field">
            <span>单词目标（个 · 累计学习）</span>
            <input type="number" v-model.number="goalEditor.vocabTarget" min="0" />
          </label>
          <div class="modal-actions">
            <button class="btn" @click="goalEditor.open = false">取消</button>
            <button class="btn primary" @click="saveGoals">保存</button>
          </div>
        </div>
      </div>

      <!-- 改密码 -->
      <div v-if="pwdEditor.open" class="modal" @click.self="pwdEditor.open = false">
        <div class="modal-card goal-card">
          <button class="modal-close" @click="pwdEditor.open = false">×</button>
          <h3>🔑 修改密码</h3>
          <label class="field"><span>原密码</span><input type="password" v-model="pwdEditor.oldPwd" /></label>
          <label class="field"><span>新密码</span><input type="password" v-model="pwdEditor.newPwd" /></label>
          <label class="field"><span>确认新密码</span><input type="password" v-model="pwdEditor.confirm" /></label>
          <div class="modal-actions">
            <button class="btn" @click="pwdEditor.open = false">取消</button>
            <button class="btn primary" @click="savePassword">保存</button>
          </div>
        </div>
      </div>

      <!-- 卷子答题 -->
      <div v-if="examModal.open" class="modal" @click.self="closeExam">
        <div class="modal-card exam-card">
          <button class="modal-close" @click="closeExam">×</button>
          <h3>📝 {{ examModal.paper.title }}</h3>
          <div class="exam-body">
            <div v-for="q in examModal.paper.questions" :key="q.id" class="exam-q">
              <div class="q-prompt"><b>{{ q.id }}.</b> {{ q.prompt }}</div>
              <div v-if="q.images && q.images.length" class="q-images">
                <img v-for="img in q.images" :key="img" :src="img" alt="" />
              </div>
              <div v-if="q.options && q.options.length" class="q-opts">
                <label v-for="opt in q.options" :key="opt">
                  <input type="radio" :name="'q-' + q.id" :value="opt" v-model="examModal.answers[q.id]" /> {{ opt }}
                </label>
              </div>
              <input v-else class="q-input" v-model="examModal.answers[q.id]" placeholder="作答…"/>
            </div>
            <div class="exam-summary">
              <h4>结束总结（可选）</h4>
              <image-attacher :images="examModal.images" :on-files="(files) => uploadFiles(files).then(urls => examModal.images.push(...urls))" />
              <textarea v-model="examModal.summary" placeholder="今天这套卷的反思 · 支持 Markdown"></textarea>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn" @click="closeExam">取消</button>
            <button class="btn primary" @click="submitExam">提交</button>
          </div>
        </div>
      </div>

      <!-- 英语工作台 -->
      <english-hub
        v-if="englishHub.open"
        :state="state" :me="me" :users="USERS"
        :tab="englishHub.tab"
        :on-tab="(t) => englishHub.tab = t"
        :on-close="() => englishHub.open = false"
        :on-edit="openEdit"
        :on-detail="openDetail"
        :on-start-flashcards="startFlashcards"
        :on-import-paper="importPaperFromFile"
        :on-start-exam="startExam"
        :today-due="todayDueWords(me)"
        :render-md="renderMarkdown"
        :fmt-time="fmtTime"
      />

      <!-- 数学工作台 -->
      <math-hub
        v-if="mathHub.open"
        :state="state" :me="me" :users="USERS"
        :tab="mathHub.tab"
        :on-tab="(t) => mathHub.tab = t"
        :on-close="() => mathHub.open = false"
        :on-edit="openEdit"
        :on-detail="openDetail"
        :on-edit-formula="openFormulaEdit"
        :on-del-formula="delFormula"
        :render-md="renderMarkdown"
        :fmt-time="fmtTime"
      />

      <!-- 统计弹窗 -->
      <div v-if="statsModal.open" class="modal" @click.self="statsModal.open = false">
        <div class="modal-card stats-card">
          <button class="modal-close" @click="statsModal.open = false">×</button>
          <stats-view :state="state" :users="USERS" :all-usernames="ALL_USERNAMES" :me="me"/>
        </div>
      </div>

      <!-- 闪卡 -->
      <div v-if="flashcardSession.open" class="modal" @click.self="flashcardSession.open = false">
        <div class="modal-card flashcard-card">
          <button class="modal-close" @click="flashcardSession.open = false">×</button>
          <div class="fc-progress">{{ flashcardSession.idx + 1 }} / {{ flashcardSession.queue.length }}</div>
          <div class="fc-card" @click="flashcardSession.showBack = !flashcardSession.showBack">
            <div v-if="!flashcardSession.showBack" class="fc-front">
              <div class="fc-word">{{ flashcardSession.queue[flashcardSession.idx]?.word }}</div>
              <div class="fc-hint">点击查看释义</div>
            </div>
            <div v-else class="fc-back">
              <div class="fc-word small">{{ flashcardSession.queue[flashcardSession.idx]?.word }}</div>
              <div class="fc-meaning">{{ flashcardSession.queue[flashcardSession.idx]?.meaning || '(无释义)' }}</div>
              <div v-if="flashcardSession.queue[flashcardSession.idx]?.markdown" class="md-body" v-html="renderMarkdown(flashcardSession.queue[flashcardSession.idx].markdown)"></div>
            </div>
          </div>
          <div v-if="flashcardSession.showBack" class="fc-actions">
            <button class="btn fc-again" @click="answerCard('again')">😵 不会 (回到 0 阶段)</button>
            <button class="btn fc-good primary" @click="answerCard('good')">✨ 会了 (下一阶段)</button>
          </div>
        </div>
      </div>

      <!-- 聊天抽屉 -->
      <chat-drawer
        v-if="chatDrawer.open"
        :state="state" :me="me" :users="USERS"
        :draft="chatDrawer.draft"
        :images="chatDrawer.images"
        :quote="chatDrawer.quote"
        :presence-map="presenceComputed"
        :fmt-time="fmtTime"
        :on-update-draft="(v) => chatDrawer.draft = v"
        :on-send="sendChat"
        :on-paste="pasteChatImages"
        :on-choose-image="chooseChatImage"
        :on-remove-image="(idx) => chatDrawer.images.splice(idx, 1)"
        :on-clear-quote="() => chatDrawer.quote = null"
        :on-close="() => chatDrawer.open = false"
      />

      <!-- 全局搜索 -->
      <div v-if="globalSearch.open" class="modal" @click.self="closeGlobalSearch">
        <div class="modal-card search-card">
          <button class="modal-close" @click="closeGlobalSearch">×</button>
          <h3>🔍 全局搜索</h3>
          <input
            v-model="globalSearch.query"
            class="global-search-input"
            placeholder="搜单词、卷子、便利贴、聊天..."
            @keydown.enter="searchResults[0] && openSearchResult(searchResults[0])"
          />
          <div class="search-results">
            <button
              v-for="item in searchResults"
              :key="item.type + item.title + item.sub"
              class="search-result"
              @click="openSearchResult(item)"
            >
              <span class="badge">{{ item.type }}</span>
              <span class="search-title">{{ item.title }}</span>
              <span class="muted">{{ item.sub }}</span>
            </button>
            <div v-if="globalSearch.query && !searchResults.length" class="empty">没有匹配结果</div>
          </div>
        </div>
      </div>

      <transition name="fade">
        <div v-if="toast" class="toast">{{ toast }}</div>
      </transition>
    </div>
  `,
});

/* -------------------- 用户面板（左 / 右） -------------------- */
app.component("UserPane", {
  props: [
    "username", "isMe", "state", "tab", "tabList", "progress", "streak",
    "listOf", "users", "onTab", "onDetail", "onEdit", "onDel",
    "onToggleTask", "onReorderNotes", "onStartExam", "onImportPaper",
    "renderMd", "fmtTime", "fmtDate", "todayKey",
  ],
  data() {
    return { draggingNoteId: "" };
  },
  computed: {
    user() { return this.users[this.username]; },
    vocabList() {
      return this.state.checkins
        .filter((c) => c.owner === this.username && c.type === "vocab")
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    paperList() { return this.state.papers; },
    attemptList() { return this.state.examAttempts.filter((a) => a.owner === this.username); },
    wrongList() { return this.listOf("wrongQuestions", this.username); },
    mathList() { return this.listOf("math", this.username); },
    todayNotes() {
      const t = this.todayKey();
      return this.state.stickyNotes
        .filter((n) => n.owner === this.username && !n.archived && n.date === t)
        .slice()
        .sort((a, b) => (Number(a.order || 0) - Number(b.order || 0)) || (a.createdAt < b.createdAt ? 1 : -1));
    },
    archivedNotes() {
      return this.state.stickyNotes.filter((n) => n.owner === this.username && n.archived).slice(0, 30);
    },
    summaryToday() {
      const t = this.todayKey();
      return this.state.dailySummaries.find((s) => s.owner === this.username && s.date === t);
    },
    summaryHistory() {
      return this.state.dailySummaries
        .filter((s) => s.owner === this.username)
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    },
  },
  methods: {
    handleNoteClick(note, evt) {
      if (!this.isMe) return;
      const t = evt.target;
      if (t && t.matches('input[type="checkbox"][data-task-index]')) {
        evt.preventDefault();
        const idx = Number(t.getAttribute("data-task-index"));
        this.onToggleTask(note, idx);
      }
    },
    handleFileInput(evt) {
      const files = Array.from(evt.target.files || []);
      if (files.length) this.onImportPaper(files);
      evt.target.value = "";
    },
    handleNoteDragStart(note, evt) {
      if (!this.isMe) return;
      this.draggingNoteId = note.id;
      evt.dataTransfer.effectAllowed = "move";
      evt.dataTransfer.setData("text/plain", note.id);
    },
    handleNoteDrop(targetNote) {
      if (!this.isMe || !this.draggingNoteId || this.draggingNoteId === targetNote.id) return;
      const notes = this.todayNotes.slice();
      const from = notes.findIndex((n) => n.id === this.draggingNoteId);
      const to = notes.findIndex((n) => n.id === targetNote.id);
      if (from < 0 || to < 0) return;
      const [moved] = notes.splice(from, 1);
      notes.splice(to, 0, moved);
      this.draggingNoteId = "";
      this.onReorderNotes(notes);
    },
  },
  template: `
    <section class="pane" :class="['side-' + user.side, isMe ? 'mine' : 'other']" :style="{ '--accent': user.color, '--accent-soft': user.colorSoft }">
      <div class="pane-head">
        <div class="pane-user">
          <span class="pane-avatar" :style="{ background: user.color }">{{ user.displayName[0] }}</span>
          <div>
            <div class="pane-name">{{ user.displayName }}</div>
            <div class="pane-meta">🔥 连续 {{ streak }} 天</div>
          </div>
        </div>
        <div class="pane-progress">
          <div class="pp-row">
            <span class="pp-label">📝 卷子</span>
            <div class="pp-bar"><div class="pp-fill" :style="{ width: progress.paper.percent + '%', background: user.color }"></div></div>
            <span class="pp-num">{{ progress.paper.done }}/{{ progress.paper.target }}</span>
          </div>
          <div class="pp-row">
            <span class="pp-label">📚 单词</span>
            <div class="pp-bar"><div class="pp-fill" :style="{ width: progress.vocab.percent + '%', background: user.color }"></div></div>
            <span class="pp-num">{{ progress.vocab.done }}/{{ progress.vocab.target }}</span>
          </div>
        </div>
      </div>

      <nav class="pane-tabs">
        <button v-for="t in tabList" :key="t.id" class="pt-btn" :class="{ active: tab === t.id }" @click="onTab(t.id)">
          <span class="pt-ico">{{ t.icon }}</span><span>{{ t.label }}</span>
        </button>
      </nav>

      <div class="pane-body">
        <!-- 单词 -->
        <div v-if="tab === 'vocab'" class="mod">
          <div class="mod-head">
            <h3>📚 单词打卡</h3>
            <button v-if="isMe" class="btn small primary" @click="onEdit('vocab')">+ 记录</button>
          </div>
          <div v-if="!vocabList.length" class="empty">还没有单词学习打卡</div>
          <ul class="card-list">
            <li v-for="v in vocabList" :key="v.id" class="card" @click="onDetail('checkin', v)">
              <div class="card-title">{{ v.title }}</div>
              <div class="card-sub">{{ v.markdown.slice(0, 80) }}</div>
              <div class="card-foot">
                <span class="badge">{{ v.amount || 0 }} {{ v.unit || '个' }}</span>
                <span class="muted">{{ fmtTime(v.createdAt) }}</span>
                <button v-if="isMe" class="link danger" @click.stop="onDel('checkin', v.id)">删</button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 卷子 -->
        <div v-if="tab === 'paper'" class="mod">
          <div class="mod-head">
            <h3>📝 卷子</h3>
            <label v-if="isMe" class="btn small">
              + 导入JSON/图片
              <input type="file" accept="application/json,.json,image/*" multiple hidden @change="handleFileInput"/>
            </label>
          </div>
          <h4 class="mod-sub">📄 卷子库</h4>
          <ul class="card-list">
            <li v-for="p in paperList" :key="p.id" class="card">
              <div class="card-title">{{ p.title }}</div>
              <div class="card-sub">{{ p.questions.length }} 题 · {{ p.tags.join(' / ') }}</div>
              <div class="card-foot">
                <button v-if="isMe" class="link" @click="onStartExam(p)">开始作答</button>
                <button v-if="isMe" class="link danger" @click="onDel('paper', p.id)">删</button>
              </div>
            </li>
          </ul>
          <h4 class="mod-sub">🏆 答题记录（CF 风格）</h4>
          <table v-if="attemptList.length" class="cf-table">
            <thead><tr><th>时间</th><th>卷子</th><th>得分</th><th>用时</th><th></th></tr></thead>
            <tbody>
              <tr v-for="a in attemptList" :key="a.id" @click="onDetail('attempt', a)">
                <td>{{ fmtTime(a.createdAt) }}</td>
                <td>{{ a.paperTitle }}</td>
                <td><b :class="a.score.percent >= 60 ? 'ok' : 'bad'">{{ a.score.correct }}/{{ a.score.total }}</b><span v-if="a.score.percent !== null"> · {{ a.score.percent }}%</span></td>
                <td>{{ a.duration }}m</td>
                <td><span class="link">查看</span></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">还没有答题记录</div>
        </div>

        <!-- 错题 -->
        <div v-if="tab === 'wrong'" class="mod">
          <div class="mod-head">
            <h3>❌ 错题本</h3>
            <button v-if="isMe" class="btn small primary" @click="onEdit('wrong')">+ 手动加</button>
          </div>
          <div v-if="!wrongList.length" class="empty">没有错题（或卷子做完会自动汇入）</div>
          <ul class="card-list">
            <li v-for="w in wrongList" :key="w.id" class="card" :class="{ done: w.mastered }" @click="onDetail('wrong', w)">
              <div class="card-title">{{ w.prompt.slice(0, 60) || '(图片错题)' }}</div>
              <div class="card-sub" v-if="w.correctAnswer">正确答案：{{ w.correctAnswer }}</div>
              <div class="card-foot">
                <span class="muted">{{ w.subject === 'math' ? '数学' : '英语' }} · {{ w.source === 'paper' ? '来自卷子' : '手动' }}</span>
                <span v-if="w.mastered" class="badge badge-mastered">已掌握</span>
                <button v-if="isMe" class="link danger" @click.stop="onDel('wrong', w.id)">删</button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 数学 -->
        <div v-if="tab === 'math'" class="mod">
          <div class="mod-head">
            <h3>🧮 数学</h3>
            <button v-if="isMe" class="btn small primary" @click="onEdit('math')">+ 添加</button>
          </div>
          <div v-if="!mathList.length" class="empty">还没有数学记录</div>
          <ul class="card-list">
            <li v-for="m in mathList" :key="m.id" class="card" @click="onDetail('math', m)">
              <div class="card-title">{{ m.title }}</div>
              <div class="card-sub">{{ m.topic }}</div>
              <div class="card-foot">
                <span class="badge" :class="'badge-' + m.status">{{ m.status }}</span>
                <button v-if="isMe" class="link danger" @click.stop="onDel('math', m.id)">删</button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 便利贴 -->
        <div v-if="tab === 'note'" class="mod">
          <div class="mod-head">
            <h3>🗒 今日便利贴</h3>
            <button v-if="isMe" class="btn small primary" @click="onEdit('note')">+ 新便利贴</button>
          </div>
          <div v-if="!todayNotes.length" class="empty">写点今天要做的吧 ✏️</div>
          <div class="sticky-grid">
            <div
              v-for="note in todayNotes" :key="note.id"
              class="sticky" :class="'sticky-' + note.color"
              :draggable="isMe"
              @dragstart="handleNoteDragStart(note, $event)"
              @dragend="draggingNoteId = ''"
              @dragover.prevent
              @drop.prevent="handleNoteDrop(note)"
              @click="(e) => handleNoteClick(note, e)"
            >
              <div class="sticky-title">
                <span>{{ note.title }}</span>
                <button v-if="isMe" class="link danger small" @click.stop="onDel('note', note.id)">删</button>
              </div>
              <div class="sticky-md md-body" v-html="renderMd(note.markdown, { editable: isMe })"></div>
              <div v-if="note.images && note.images.length" class="sticky-imgs">
                <img v-for="img in note.images" :key="img" :src="img" @click.stop="onDetail('note', note)"/>
              </div>
              <button v-if="isMe" class="link sticky-edit" @click.stop="onEdit('note', note)">编辑</button>
            </div>
          </div>

          <h4 class="mod-sub">🗂 历史便利贴</h4>
          <div class="archived-list">
            <div v-for="note in archivedNotes" :key="note.id" class="archived-item" @click="onDetail('note', note)">
              <span class="archived-date">{{ note.date }}</span>
              <span class="archived-title">{{ note.title }}</span>
            </div>
            <div v-if="!archivedNotes.length" class="empty">还没有归档</div>
          </div>
        </div>

        <!-- 总结 -->
        <div v-if="tab === 'summary'" class="mod">
          <div class="mod-head">
            <h3>🌙 每日总结</h3>
            <button v-if="isMe" class="btn small primary" @click="onEdit('summary', summaryToday || {})">{{ summaryToday ? '编辑今日' : '+ 写今日' }}</button>
          </div>
          <div v-if="summaryToday" class="summary-card today" @click="onDetail('summary', summaryToday)">
            <div class="card-title">今天 · {{ summaryToday.date }}</div>
            <div class="md-body" v-html="renderMd(summaryToday.markdown)"></div>
            <div v-if="summaryToday.images && summaryToday.images.length" class="img-row">
              <img v-for="img in summaryToday.images" :key="img" :src="img"/>
            </div>
          </div>
          <h4 class="mod-sub">📜 历史</h4>
          <ul class="card-list">
            <li v-for="s in summaryHistory" :key="s.id" class="card" @click="onDetail('summary', s)">
              <div class="card-title">{{ s.date }}</div>
              <div class="card-sub">{{ s.markdown.slice(0, 80) }}</div>
            </li>
            <div v-if="!summaryHistory.length" class="empty">还没有总结</div>
          </ul>
        </div>
      </div>
    </section>
  `,
});

/* -------------------- 详情视图 -------------------- */
app.component("DetailView", {
  props: ["type", "entry", "state", "users", "renderMd", "fmtTime"],
  computed: {
    attemptPaper() {
      if (this.type !== "attempt") return null;
      return this.state.papers.find((p) => p.id === this.entry.paperId) || null;
    },
    attemptQuestionRows() {
      if (!this.attemptPaper) return [];
      return this.attemptPaper.questions.map((q) => ({
        ...q,
        yourAnswer: this.entry.answers ? this.entry.answers[q.id] : "",
        isWrong: this.entry.score.wrong.some((w) => w.questionId === q.id),
      }));
    },
  },
  template: `
    <div class="detail">
      <div v-if="type === 'checkin'">
        <h3>{{ entry.title }}</h3>
        <div class="detail-meta">
          <span class="me-tag" :style="{ background: users[entry.owner].color }">{{ users[entry.owner].displayName }}</span>
          <span>{{ fmtTime(entry.createdAt) }}</span>
          <span v-if="entry.amount">{{ entry.amount }} {{ entry.unit }}</span>
        </div>
        <div class="md-body" v-html="renderMd(entry.markdown)"></div>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
      <div v-else-if="type === 'attempt'">
        <h3>📝 {{ entry.paperTitle }}</h3>
        <div class="detail-meta">
          <span class="me-tag" :style="{ background: users[entry.owner].color }">{{ users[entry.owner].displayName }}</span>
          <span>{{ fmtTime(entry.createdAt) }}</span>
          <span class="big-score">{{ entry.score.correct }}/{{ entry.score.total }} <small v-if="entry.score.percent !== null">{{ entry.score.percent }}%</small></span>
        </div>
        <h4>错题（{{ entry.score.wrong.length }}）</h4>
        <ul class="wrong-list">
          <li v-for="w in entry.score.wrong" :key="w.questionId">
            <div><b>{{ w.questionId }}.</b> {{ w.prompt }}</div>
            <div class="muted">你：{{ w.yourAnswer || '(未答)' }} ｜ 正确：{{ w.correctAnswer }}</div>
            <div v-if="w.note" class="note">💡 {{ w.note }}</div>
          </li>
          <li v-if="!entry.score.wrong.length" class="muted">没有错题，全对！🎉</li>
        </ul>
        <h4>逐题回看</h4>
        <div v-if="attemptQuestionRows.length" class="answer-review">
          <div v-for="q in attemptQuestionRows" :key="q.id" class="answer-row" :class="{ wrong: q.isWrong }">
            <div class="answer-head">
              <b>{{ q.id }}.</b>
              <span class="badge" :class="q.isWrong ? 'badge-again' : 'badge-mastered'">{{ q.isWrong ? '错题' : '正确' }}</span>
            </div>
            <div class="answer-prompt">{{ q.prompt }}</div>
            <div v-if="q.images && q.images.length" class="q-images">
              <img v-for="img in q.images" :key="img" :src="img" alt="" />
            </div>
            <div class="answer-compare">
              <span>你：{{ q.yourAnswer || '(未答)' }}</span>
              <span>正确：{{ q.answer }}</span>
            </div>
            <div v-if="q.note" class="note">💡 {{ q.note }}</div>
          </div>
        </div>
        <div v-else class="muted">原卷已删除，暂不能逐题回看。</div>
        <h4>结束总结</h4>
        <div class="md-body" v-html="renderMd(entry.markdown)"></div>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
      <div v-else-if="type === 'vocab'">
        <h3>{{ entry.word }}</h3>
        <div class="detail-meta"><span>复习 {{ entry.reviews }} 次 · 状态 {{ entry.status }}</span></div>
        <p>{{ entry.meaning }}</p>
        <div class="md-body" v-html="renderMd(entry.markdown)"></div>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
      <div v-else-if="type === 'wrong'">
        <h3>❌ 错题</h3>
        <div class="detail-meta">
          <span>{{ entry.subject === 'math' ? '数学' : '英语' }}</span>
          <span>{{ entry.source === 'paper' ? '来自卷子: ' + entry.paperTitle : '手动添加' }}</span>
        </div>
        <div class="block"><b>题目</b><p>{{ entry.prompt }}</p></div>
        <div class="block"><b>你的答案</b><p>{{ entry.yourAnswer || '(未答)' }}</p></div>
        <div class="block"><b>正确答案</b><p>{{ entry.correctAnswer }}</p></div>
        <div v-if="entry.note" class="block"><b>笔记</b><div class="md-body" v-html="renderMd(entry.note)"></div></div>
        <button v-if="!entry.mastered" class="btn primary" @click="$emit('mark-mastered', entry.id)">标记已掌握</button>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
      <div v-else-if="type === 'math'">
        <h3>🧮 {{ entry.title }}</h3>
        <div class="detail-meta">
          <span>{{ entry.topic }}</span>
          <span>状态 {{ entry.status }}</span>
        </div>
        <div class="md-body" v-html="renderMd(entry.markdown)"></div>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
      <div v-else-if="type === 'note'">
        <h3>🗒 {{ entry.title }}</h3>
        <div class="detail-meta"><span>{{ entry.date }}</span><span v-if="entry.archived">已归档</span></div>
        <div class="md-body" v-html="renderMd(entry.markdown)"></div>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
      <div v-else-if="type === 'summary'">
        <h3>🌙 每日总结 · {{ entry.date }}</h3>
        <div class="detail-meta">
          <span class="me-tag" :style="{ background: users[entry.owner].color }">{{ users[entry.owner].displayName }}</span>
        </div>
        <div class="md-body" v-html="renderMd(entry.markdown)"></div>
        <div v-if="entry.images && entry.images.length" class="img-grid">
          <img v-for="img in entry.images" :key="img" :src="img"/>
        </div>
      </div>
    </div>
  `,
});

/* -------------------- 编辑表单 -------------------- */
app.component("EditForm", {
  props: ["type", "form", "onFiles", "onRemove", "onSubmit", "onCancel", "renderMd", "state", "me", "todayKey"],
  setup(props) {
    const preview = ref(false);
    const dragOver = ref(false);
    function handlePaste(evt) {
      const items = evt.clipboardData && evt.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) if (it.kind === "file") files.push(it.getAsFile());
      if (files.length) { evt.preventDefault(); props.onFiles(props.form, files); }
    }
    function handleDrop(evt) {
      evt.preventDefault();
      dragOver.value = false;
      if (evt.dataTransfer.files.length) props.onFiles(props.form, evt.dataTransfer.files);
    }
    function handleFileInput(evt) {
      if (evt.target.files.length) props.onFiles(props.form, evt.target.files);
      evt.target.value = "";
    }
    return { preview, dragOver, handlePaste, handleDrop, handleFileInput };
  },
  computed: {
    todayCheckins() {
      if (this.type !== "summary" || !this.state) return [];
      const day = this.form.date || this.todayKey();
      return this.state.checkins
        .filter((c) => c.owner === this.me && c.createdAt.slice(0, 10) === day)
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },
  },
  methods: {
    insertCheckinLine(c) {
      const line = `- ✅ ${c.title}${c.markdown ? `：${c.markdown}` : ""}`;
      const prefix = this.form.markdown && !this.form.markdown.endsWith("\n") ? "\n" : "";
      this.form.markdown = `${this.form.markdown || ""}${prefix}${line}\n`;
    },
  },
  template: `
    <div class="edit">
      <h3>{{ type === 'vocab' ? '📚 单词学习打卡' : type === 'math' ? '🧮 数学题' : type === 'wrong' ? '❌ 错题' : type === 'note' ? '🗒 便利贴' : type === 'summary' ? '🌙 每日总结' : '✍️ 打卡' }}</h3>

      <div v-if="type === 'vocab'" class="ef-fields">
        <label class="field"><span>时间（分钟）</span><input type="number" min="0" v-model.number="form.duration" placeholder="30"/></label>
        <label class="field"><span>学了多少（个）</span><input type="number" min="0" v-model.number="form.amount" placeholder="50"/></label>
      </div>

      <div v-else-if="type === 'math'" class="ef-fields">
        <label class="field"><span>标题</span><input v-model="form.title"/></label>
        <label class="field"><span>主题</span>
          <select v-model="form.topic">
            <option value="algebra">代数</option>
            <option value="geometry">几何</option>
            <option value="calculus">微积分</option>
            <option value="probability">概率统计</option>
            <option value="wrongbook">错题本</option>
            <option value="mixed">综合</option>
          </select>
        </label>
        <label class="field"><span>状态</span>
          <select v-model="form.status">
            <option value="todo">待做</option>
            <option value="stuck">卡住</option>
            <option value="solved">已解决</option>
            <option value="review">复盘</option>
          </select>
        </label>
      </div>

      <div v-else-if="type === 'wrong'" class="ef-fields">
        <label class="field"><span>科目</span>
          <select v-model="form.subject"><option value="english">英语</option><option value="math">数学</option></select>
        </label>
        <label class="field"><span>题目</span><textarea v-model="form.prompt" rows="2"/></label>
        <label class="field"><span>你的答案</span><input v-model="form.yourAnswer"/></label>
        <label class="field"><span>正确答案</span><input v-model="form.correctAnswer"/></label>
      </div>

      <div v-else-if="type === 'note'" class="ef-fields">
        <label class="field"><span>标题</span><input v-model="form.title"/></label>
        <label class="field"><span>颜色</span>
          <select v-model="form.color">
            <option value="yellow">黄</option>
            <option value="green">绿</option>
            <option value="pink">粉</option>
            <option value="blue">蓝</option>
            <option value="purple">紫</option>
            <option value="orange">橙</option>
            <option value="cyan">青</option>
          </select>
        </label>
      </div>

      <div v-else-if="type === 'summary'" class="ef-fields">
        <label class="field"><span>日期</span><input type="date" v-model="form.date"/></label>
      </div>

      <div v-else-if="type === 'checkin'" class="ef-fields">
        <label class="field"><span>标题</span><input v-model="form.title"/></label>
        <label class="field"><span>科目</span>
          <select v-model="form.subject"><option value="english">英语</option><option value="math">数学</option><option value="general">通用</option></select>
        </label>
        <label class="field row"><span>用时</span>
          <input type="number" v-model.number="form.amount" style="flex: 1"/>
          <input v-model="form.unit" style="width: 80px" placeholder="min"/>
        </label>
      </div>

      <div v-if="type === 'summary'" class="summary-helper">
        <div class="summary-helper-head">今日打卡</div>
        <button
          v-for="c in todayCheckins"
          :key="c.id"
          class="summary-checkin"
          @click="insertCheckinLine(c)"
        >
          <span>{{ c.title }}</span>
          <span class="muted">{{ c.markdown }}</span>
        </button>
        <div v-if="!todayCheckins.length" class="empty">这天还没有打卡</div>
      </div>

      <div class="ef-md">
        <div class="ef-md-head">
          <span>📝 {{ type === 'vocab' ? '自己的想法' : type === 'wrong' ? '笔记' : '内容' }} (Markdown · 支持 - [ ] 任务列表)</span>
          <button class="link" @click="preview = !preview">{{ preview ? '编辑' : '预览' }}</button>
        </div>
        <textarea v-if="!preview" v-model="form.markdown" @paste="handlePaste" rows="8" placeholder="可以粘贴图片 (Ctrl+V) · 拖拽图片到下方区域"/>
        <div v-else class="md-body preview" v-html="renderMd(form.markdown)"></div>
      </div>

      <div class="ef-images" :class="{ over: dragOver }"
           @dragover.prevent="dragOver = true"
           @dragleave.prevent="dragOver = false"
           @drop="handleDrop">
        <div class="ef-img-head">
          <span>📷 图片 ({{ form.images.length }})</span>
          <label class="link">
            + 上传<input type="file" accept="image/*" multiple hidden @change="handleFileInput"/>
          </label>
          <span class="muted small">或拖拽 / Ctrl+V 粘贴</span>
        </div>
        <div class="ef-img-list">
          <div v-for="(img, idx) in form.images" :key="img" class="ef-img-item">
            <img :src="img"/>
            <button class="link danger" @click="onRemove(form, idx)">×</button>
          </div>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn" @click="onCancel">取消</button>
        <button class="btn primary" @click="onSubmit">保存</button>
      </div>
    </div>
  `,
});

/* -------------------- 英语工作台 -------------------- */
app.component("EnglishHub", {
  props: ["state", "me", "users", "tab", "onTab", "onClose", "onEdit", "onDetail", "onStartFlashcards", "onImportPaper", "onStartExam", "todayDue", "renderMd", "fmtTime"],
  setup() {
    const filterTag = ref("");
    const filterStatus = ref("");
    const paperQuery = ref("");
    const wrongFilter = ref("all"); // all / not-mastered / mastered
    const wrongSort = ref("recent"); // recent / count / unmastered
    const expandedAttemptIds = reactive({});
    return { filterTag, filterStatus, paperQuery, wrongFilter, wrongSort, expandedAttemptIds };
  },
  computed: {
    myVocab() { return this.state.vocab.filter((v) => v.owner === this.me); },
    myVocabLogs() {
      return this.state.checkins
        .filter((c) => c.owner === this.me && c.type === "vocab")
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    vocabLogTotal() {
      return this.myVocabLogs.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    },
    filteredVocab() {
      return this.myVocab.filter((v) => {
        if (this.filterStatus && v.status !== this.filterStatus) return false;
        if (this.filterTag && !(v.tags || []).includes(this.filterTag)) return false;
        return true;
      });
    },
    vocabStatusCount() {
      const c = { learning: 0, mastered: 0, again: 0 };
      for (const v of this.myVocab) c[v.status] = (c[v.status] || 0) + 1;
      return c;
    },
    filteredPapers() {
      const q = this.paperQuery.toLowerCase().trim();
      if (!q) return this.state.papers;
      return this.state.papers.filter(
        (p) => p.title.toLowerCase().includes(q) || (p.tags || []).some((t) => t.toLowerCase().includes(q)),
      );
    },
    myAttempts() {
      return this.state.examAttempts.filter((a) => a.owner === this.me);
    },
    paperHistorySummary() {
      const ids = new Set(this.myAttempts.map((a) => a.paperId));
      const scores = this.myAttempts.map((a) => Number(a.score.percent || 0));
      const avg = scores.length ? Math.round(scores.reduce((sum, x) => sum + x, 0) / scores.length) : 0;
      return { paperCount: ids.size, avg };
    },
    myWrong() {
      return this.state.wrongQuestions.filter(
        (w) => w.owner === this.me && (w.subject === "english" || !w.subject),
      );
    },
    wrongAggregated() {
      const map = {};
      for (const w of this.myWrong) {
        const fallback = (w.prompt || w.id).trim().toLowerCase();
        const key = w.paperId && w.questionId ? `${w.paperId}:${w.questionId}` : fallback;
        if (!map[key]) map[key] = { ...w, occurrences: [] };
        map[key].occurrences.push(w);
        if (!map[key].createdAt || w.createdAt > map[key].createdAt) Object.assign(map[key], w);
      }
      return Object.values(map).map((w) => ({
        ...w,
        occurrenceCount: w.occurrences.length,
        hasUnmastered: w.occurrences.some((item) => !item.mastered),
      }));
    },
    wrongDisplay() {
      let rows = this.wrongAggregated;
      if (this.wrongFilter === "mastered") rows = rows.filter((w) => !w.hasUnmastered);
      if (this.wrongFilter === "not-mastered") rows = rows.filter((w) => w.hasUnmastered);
      return rows.slice().sort((a, b) => {
        if (this.wrongSort === "count") return b.occurrenceCount - a.occurrenceCount || (a.createdAt < b.createdAt ? 1 : -1);
        if (this.wrongSort === "unmastered") return Number(b.hasUnmastered) - Number(a.hasUnmastered) || b.occurrenceCount - a.occurrenceCount;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
    },
    paperStatsByPaper() {
      const map = {};
      for (const a of this.myAttempts) {
        if (!map[a.paperId]) map[a.paperId] = { count: 0, totalPercent: 0, last: null };
        map[a.paperId].count++;
        map[a.paperId].totalPercent += a.score.percent || 0;
        if (!map[a.paperId].last || a.createdAt > map[a.paperId].last) map[a.paperId].last = a.createdAt;
      }
      return map;
    },
  },
  methods: {
    handleImport(evt) {
      const files = Array.from(evt.target.files || []);
      if (files.length) this.onImportPaper(files);
      evt.target.value = "";
    },
    toggleAttempt(id) {
      this.expandedAttemptIds[id] = !this.expandedAttemptIds[id];
    },
  },
  template: `
    <div class="modal hub-modal" @click.self="onClose">
      <div class="hub-card">
        <div class="hub-head">
          <h2>📚 英语工作台</h2>
          <button class="modal-close" @click="onClose">×</button>
        </div>
        <nav class="hub-tabs">
          <button :class="{ active: tab === 'vocab' }" @click="onTab('vocab')">📖 单词打卡 ({{ myVocabLogs.length }})</button>
          <button :class="{ active: tab === 'flashcards' }" @click="onTab('flashcards')">🎴 闪卡复习 ({{ todayDue.length }})</button>
          <button :class="{ active: tab === 'papers' }" @click="onTab('papers')">📝 卷子 ({{ state.papers.length }})</button>
          <button :class="{ active: tab === 'wrong' }" @click="onTab('wrong')">❌ 错题 ({{ myWrong.length }})</button>
          <button :class="{ active: tab === 'stats' }" @click="onTab('stats')">📊 进度</button>
        </nav>

        <div class="hub-body">
          <!-- 单词打卡 -->
          <div v-if="tab === 'vocab'" class="hub-vocab">
            <div class="hub-toolbar">
              <span class="muted">累计学习 {{ vocabLogTotal }} 个 · 打卡 {{ myVocabLogs.length }} 次</span>
              <button class="btn small primary" @click="onEdit('vocab')">+ 记录单词学习</button>
            </div>
            <div v-if="!myVocabLogs.length" class="empty">还没有单词学习打卡</div>
            <div class="vocab-grid">
              <div v-for="v in myVocabLogs" :key="v.id" class="vocab-card" @click="onDetail('checkin', v)">
                <div class="vc-head">
                  <span class="vc-word">{{ v.title }}</span>
                  <span class="badge">{{ v.amount || 0 }} 个</span>
                </div>
                <div class="vc-meaning">{{ v.markdown.slice(0, 90) || '(没有想法记录)' }}</div>
                <div class="vc-foot">
                  <span class="muted">{{ fmtTime(v.createdAt) }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 闪卡 -->
          <div v-if="tab === 'flashcards'" class="hub-flashcards">
            <div class="fc-summary">
              <div class="fc-summary-num">{{ todayDue.length }}</div>
              <div class="fc-summary-label">今日待复习</div>
              <p class="muted">基于艾宾浩斯曲线（1 / 3 / 7 / 15 天）。新加的单词会自动进入第一阶段。</p>
            </div>
            <button class="btn primary big" @click="onStartFlashcards" :disabled="!todayDue.length">
              🎴 开始今日复习
            </button>
            <div class="fc-due-list">
              <h4>预览</h4>
              <ul class="card-list">
                <li v-for="v in todayDue.slice(0, 20)" :key="v.id" class="card">
                  <div class="card-title">{{ v.word }}</div>
                  <div class="card-sub">{{ v.meaning }}</div>
                  <div class="card-foot"><span class="muted">阶段 {{ v.stage || 0 }}</span></div>
                </li>
                <li v-if="!todayDue.length" class="empty">今天没有要复习的词 ✨</li>
              </ul>
            </div>
          </div>

          <!-- 卷子 -->
          <div v-if="tab === 'papers'" class="hub-papers">
            <div class="hub-toolbar">
              <input v-model="paperQuery" placeholder="🔍 搜索标题 / 标签" class="search-input"/>
              <label class="btn small">+ 导入JSON/图片<input type="file" accept=".json,application/json,image/*" multiple hidden @change="handleImport"/></label>
            </div>
            <div v-if="!filteredPapers.length" class="empty">还没有卷子，点击导入 JSON</div>
            <ul class="card-list">
              <li v-for="p in filteredPapers" :key="p.id" class="card paper-card">
                <div class="card-title">{{ p.title }}</div>
                <div class="card-sub">
                  {{ p.questions.length }} 题 ·
                  <span v-for="t in p.tags" :key="t" class="tag">{{ t }}</span>
                </div>
                <div class="paper-stats">
                  <span v-if="paperStatsByPaper[p.id]" class="muted">
                    我做过 {{ paperStatsByPaper[p.id].count }} 次 · 平均 {{ Math.round(paperStatsByPaper[p.id].totalPercent / paperStatsByPaper[p.id].count) }}%
                  </span>
                  <span v-else class="muted">还没做过</span>
                </div>
                <div class="card-foot">
                  <button class="link" @click="onStartExam(p)">开始作答</button>
                </div>
              </li>
            </ul>

            <h4 class="mod-sub">📜 我的答题历史</h4>
            <p v-if="myAttempts.length" class="muted history-summary">
              我做过 {{ paperHistorySummary.paperCount }} 套不同卷子，平均分 {{ paperHistorySummary.avg }}%
            </p>
            <table v-if="myAttempts.length" class="cf-table">
              <thead><tr><th>时间</th><th>卷子</th><th>得分</th><th>用时</th><th>摘要</th></tr></thead>
              <tbody>
                <template v-for="a in myAttempts" :key="a.id">
                  <tr @click="toggleAttempt(a.id)">
                    <td>{{ fmtTime(a.createdAt) }}</td>
                    <td>{{ a.paperTitle }}</td>
                    <td><b :class="(a.score.percent || 0) >= 60 ? 'ok' : 'bad'">{{ a.score.correct }}/{{ a.score.total }}</b></td>
                    <td>{{ a.duration }}m</td>
                    <td><button class="link" @click.stop="onDetail('attempt', a)">详情</button></td>
                  </tr>
                  <tr v-if="expandedAttemptIds[a.id]" class="attempt-expanded">
                    <td colspan="5">
                      <div v-if="a.score.wrong.length" class="attempt-wrong-list">
                        <div v-for="w in a.score.wrong" :key="w.questionId" class="attempt-wrong-item">
                          <b>{{ w.questionId }}.</b> {{ w.prompt }}
                          <span class="muted">你：{{ w.yourAnswer || '(未答)' }} ｜ 正确：{{ w.correctAnswer }}</span>
                        </div>
                      </div>
                      <div v-else class="muted">本次没有错题。</div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <!-- 错题分析 -->
          <div v-if="tab === 'wrong'" class="hub-wrong">
            <div class="hub-toolbar">
              <select v-model="wrongFilter">
                <option value="all">全部</option>
                <option value="not-mastered">未掌握</option>
                <option value="mastered">已掌握</option>
              </select>
              <div class="segmented">
                <button :class="{ active: wrongSort === 'recent' }" @click="wrongSort = 'recent'">最近</button>
                <button :class="{ active: wrongSort === 'count' }" @click="wrongSort = 'count'">出错最多</button>
                <button :class="{ active: wrongSort === 'unmastered' }" @click="wrongSort = 'unmastered'">未掌握优先</button>
              </div>
              <button class="btn small primary" @click="onEdit('wrong')">+ 手动加</button>
            </div>
            <div v-if="!wrongDisplay.length" class="empty">没有错题</div>
            <ul class="card-list">
              <li v-for="w in wrongDisplay" :key="w.id" class="card" :class="{ done: !w.hasUnmastered }" @click="onDetail('wrong', w)">
                <div class="card-title">{{ w.prompt.slice(0, 80) || '(图片错题)' }}</div>
                <div class="card-sub">正确：{{ w.correctAnswer }}</div>
                <div class="card-foot">
                  <span class="muted">{{ w.source === 'paper' ? '来自: ' + w.paperTitle : '手动' }}</span>
                  <span class="badge">错 {{ w.occurrenceCount }} 次</span>
                  <span v-if="!w.hasUnmastered" class="badge badge-mastered">已掌握</span>
                </div>
              </li>
            </ul>
          </div>

          <!-- 进度统计 -->
          <div v-if="tab === 'stats'" class="hub-stats">
            <p class="muted">完整图表（热力图 / 折线 / 饼图）由 codex_continue.md 中的任务实现。当前显示文字汇总：</p>
            <div class="stats-grid">
              <div class="stat-box">
                <div class="stat-num">{{ vocabLogTotal }}</div>
                <div class="stat-label">累计学词</div>
              </div>
              <div class="stat-box">
                <div class="stat-num">{{ vocabStatusCount.mastered || 0 }}</div>
                <div class="stat-label">已掌握</div>
              </div>
              <div class="stat-box">
                <div class="stat-num">{{ myAttempts.length }}</div>
                <div class="stat-label">卷子答题</div>
              </div>
              <div class="stat-box">
                <div class="stat-num">{{ myWrong.filter(w => !w.mastered).length }}</div>
                <div class="stat-label">未掌握错题</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
});

/* -------------------- 数学工作台 -------------------- */
app.component("MathHub", {
  props: ["state", "me", "users", "tab", "onTab", "onClose", "onEdit", "onDetail", "onEditFormula", "onDelFormula", "renderMd", "fmtTime"],
  setup() {
    const topicFilter = ref("");
    return { topicFilter };
  },
  computed: {
    myMath() { return this.state.math.filter((m) => m.owner === this.me); },
    filteredMath() {
      if (!this.topicFilter) return this.myMath;
      return this.myMath.filter((m) => m.topic === this.topicFilter);
    },
    topicCount() {
      const c = {};
      for (const m of this.myMath) c[m.topic] = (c[m.topic] || 0) + 1;
      return c;
    },
    myMathWrong() {
      return this.state.wrongQuestions.filter((w) => w.owner === this.me && w.subject === "math");
    },
    myFormulas() { return this.state.formulaNotes.filter((n) => n.owner === this.me); },
  },
  template: `
    <div class="modal hub-modal" @click.self="onClose">
      <div class="hub-card">
        <div class="hub-head">
          <h2>🧮 数学工作台</h2>
          <button class="modal-close" @click="onClose">×</button>
        </div>
        <nav class="hub-tabs">
          <button :class="{ active: tab === 'topics' }" @click="onTab('topics')">📐 题集 ({{ myMath.length }})</button>
          <button :class="{ active: tab === 'wrong' }" @click="onTab('wrong')">❌ 错题 ({{ myMathWrong.length }})</button>
          <button :class="{ active: tab === 'formulas' }" @click="onTab('formulas')">📜 公式笔记 ({{ myFormulas.length }})</button>
          <button :class="{ active: tab === 'stats' }" @click="onTab('stats')">📊 统计</button>
        </nav>

        <div class="hub-body">
          <!-- 题集 -->
          <div v-if="tab === 'topics'" class="hub-math-topics">
            <div class="hub-toolbar">
              <select v-model="topicFilter">
                <option value="">全部主题</option>
                <option value="algebra">代数 ({{ topicCount.algebra || 0 }})</option>
                <option value="geometry">几何 ({{ topicCount.geometry || 0 }})</option>
                <option value="calculus">微积分 ({{ topicCount.calculus || 0 }})</option>
                <option value="probability">概率统计 ({{ topicCount.probability || 0 }})</option>
                <option value="wrongbook">错题本 ({{ topicCount.wrongbook || 0 }})</option>
                <option value="mixed">综合 ({{ topicCount.mixed || 0 }})</option>
              </select>
              <button class="btn small primary" @click="onEdit('math')">+ 添加题</button>
            </div>
            <div v-if="!filteredMath.length" class="empty">没有题</div>
            <ul class="card-list">
              <li v-for="m in filteredMath" :key="m.id" class="card" @click="onDetail('math', m)">
                <div class="card-title">{{ m.title }}</div>
                <div class="card-sub">{{ m.topic }}</div>
                <div class="card-foot">
                  <span class="badge" :class="'badge-' + m.status">{{ m.status }}</span>
                </div>
              </li>
            </ul>
          </div>

          <!-- 错题 -->
          <div v-if="tab === 'wrong'" class="hub-math-wrong">
            <div class="hub-toolbar">
              <button class="btn small primary" @click="onEdit('wrong')">+ 加错题</button>
            </div>
            <div v-if="!myMathWrong.length" class="empty">没有数学错题</div>
            <ul class="card-list">
              <li v-for="w in myMathWrong" :key="w.id" class="card" :class="{ done: w.mastered }" @click="onDetail('wrong', w)">
                <div class="card-title">{{ w.prompt.slice(0, 80) || '(图片错题)' }}</div>
                <div class="card-sub">正确：{{ w.correctAnswer }}</div>
                <div class="card-foot">
                  <span v-if="w.mastered" class="badge badge-mastered">已掌握</span>
                </div>
              </li>
            </ul>
          </div>

          <!-- 公式笔记 -->
          <div v-if="tab === 'formulas'" class="hub-formulas">
            <div class="hub-toolbar">
              <button class="btn small primary" @click="onEditFormula(null)">+ 新公式笔记</button>
            </div>
            <div v-if="!myFormulas.length" class="empty">还没有公式笔记，写一份吧 📝</div>
            <div class="formula-grid">
              <div v-for="n in myFormulas" :key="n.id" class="formula-card">
                <div class="fc-head">
                  <h4>{{ n.title }}</h4>
                  <span class="tag">{{ n.tag }}</span>
                </div>
                <div class="md-body" v-html="renderMd(n.markdown)"></div>
                <div class="card-foot">
                  <button class="link" @click="onEditFormula(n)">编辑</button>
                  <button class="link danger" @click="onDelFormula(n.id)">删</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 统计 -->
          <div v-if="tab === 'stats'" class="hub-stats">
            <p class="muted">完整图表见 codex_continue.md。当前数据汇总：</p>
            <div class="stats-grid">
              <div class="stat-box">
                <div class="stat-num">{{ myMath.length }}</div>
                <div class="stat-label">题总数</div>
              </div>
              <div class="stat-box">
                <div class="stat-num">{{ myMath.filter(m => m.status === 'solved').length }}</div>
                <div class="stat-label">已解决</div>
              </div>
              <div class="stat-box">
                <div class="stat-num">{{ myMathWrong.length }}</div>
                <div class="stat-label">错题</div>
              </div>
              <div class="stat-box">
                <div class="stat-num">{{ myFormulas.length }}</div>
                <div class="stat-label">公式笔记</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
});

/* -------------------- 聊天抽屉 -------------------- */
app.component("ChatDrawer", {
  props: ["state", "me", "users", "draft", "images", "quote", "presenceMap", "fmtTime", "onUpdateDraft", "onSend", "onPaste", "onChooseImage", "onRemoveImage", "onClearQuote", "onClose"],
  computed: {
    sortedMessages() {
      return this.state.chatMessages.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },
    other() {
      return this.me === "qsky" ? "liutao" : "qsky";
    },
  },
  watch: {
    "state.chatMessages.length"() { this.$nextTick(() => this.scrollBottom()); },
  },
  mounted() { this.scrollBottom(); },
  methods: {
    scrollBottom() {
      const el = this.$refs.list;
      if (el) el.scrollTop = el.scrollHeight;
    },
    handleEnter(evt) {
      if (evt.shiftKey) return;
      evt.preventDefault();
      this.onSend();
    },
  },
  template: `
    <div class="chat-drawer">
      <div class="chat-head">
        <div>
          <span class="dot" :class="'dot-' + presenceMap[other].status"></span>
          <b>{{ users[other].displayName }}</b>
          <span class="presence-text">{{ presenceMap[other].text }}</span>
        </div>
        <button class="modal-close" @click="onClose">×</button>
      </div>
      <div class="chat-list" ref="list">
        <div v-if="!sortedMessages.length" class="empty">还没有消息 · 来打个招呼吧 👋</div>
        <div v-for="m in sortedMessages" :key="m.id" class="msg" :class="m.from === me ? 'mine' : 'other'">
          <span class="msg-avatar" :style="{ background: users[m.from].color }">{{ users[m.from].displayName[0] }}</span>
          <div class="msg-body">
            <div v-if="m.quote" class="msg-quote">📌 引用: {{ m.quote.title }}</div>
            <div v-if="m.text" class="msg-text">{{ m.text }}</div>
            <div v-if="m.images && m.images.length" class="msg-imgs">
              <img v-for="img in m.images" :key="img" :src="img"/>
            </div>
            <div class="msg-time">{{ fmtTime(m.createdAt) }}</div>
          </div>
        </div>
      </div>
      <div v-if="quote" class="chat-quote-bar">
        📌 引用: {{ quote.title }}<button class="link" @click="onClearQuote">清除</button>
      </div>
      <div v-if="images.length" class="chat-img-preview">
        <div v-for="(img, idx) in images" :key="img" class="ef-img-item">
          <img :src="img"/>
          <button class="link danger" @click="onRemoveImage(idx)">×</button>
        </div>
      </div>
      <div class="chat-input">
        <textarea
          :value="draft"
          @input="onUpdateDraft($event.target.value)"
          @paste="onPaste"
          @keydown.enter="handleEnter"
          placeholder="说点什么... (Enter 发送, Shift+Enter 换行, Ctrl+V 粘贴图片)"
          rows="2"
        />
        <div class="chat-actions">
          <label class="link">📷<input type="file" accept="image/*" multiple hidden @change="onChooseImage"/></label>
          <button class="btn primary small" @click="onSend">发送</button>
        </div>
      </div>
    </div>
  `,
});

/* -------------------- 轻量 SVG 图表 -------------------- */
app.component("HeatmapChart", {
  props: ["data", "color", "label"],
  computed: {
    cells() {
      const end = new Date();
      end.setHours(0, 0, 0, 0);
      const start = new Date(end);
      start.setDate(start.getDate() - 370);
      start.setDate(start.getDate() - start.getDay());
      const cells = [];
      for (let week = 0; week < 53; week++) {
        for (let day = 0; day < 7; day++) {
          const d = new Date(start);
          d.setDate(start.getDate() + week * 7 + day);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const value = Number((this.data || {})[key] || 0);
          cells.push({ key, value, x: week * 14, y: day * 14, fill: this.levelColor(value) });
        }
      }
      return cells;
    },
  },
  methods: {
    levelColor(value) {
      if (!value) return "#eee9df";
      const base = this.color || "#a8b5a0";
      const palette = ["#dfe7d8", this.mix(base, "#ffffff", 0.45), this.mix(base, "#5b6f57", 0.15), this.mix(base, "#2f3f2d", 0.35)];
      if (value <= 2) return palette[1];
      if (value <= 4) return palette[2];
      return palette[3];
    },
    mix(a, b, weight) {
      const pa = this.hex(a);
      const pb = this.hex(b);
      return `rgb(${Math.round(pa.r * (1 - weight) + pb.r * weight)}, ${Math.round(pa.g * (1 - weight) + pb.g * weight)}, ${Math.round(pa.b * (1 - weight) + pb.b * weight)})`;
    },
    hex(value) {
      const s = String(value || "#a8b5a0").replace("#", "");
      const n = parseInt(s.length === 3 ? s.split("").map((x) => x + x).join("") : s, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    },
  },
  template: `
    <div class="stat-chart heatmap-chart">
      <div v-if="label" class="stat-chart-label">{{ label }}</div>
      <svg viewBox="0 0 742 98" role="img" aria-label="365 天打卡热力图">
        <rect v-for="c in cells" :key="c.key" :x="c.x" :y="c.y" width="12" height="12" rx="2" :fill="c.fill">
          <title>{{ c.key }} · {{ c.value }} 次</title>
        </rect>
      </svg>
    </div>
  `,
});

app.component("LineChart", {
  props: ["data", "color"],
  computed: {
    points() {
      return (this.data || []).slice().sort((a, b) => String(a.x).localeCompare(String(b.x)));
    },
    coords() {
      const w = 640;
      const h = 200;
      const pad = 28;
      if (!this.points.length) return [];
      const maxY = Math.max(100, ...this.points.map((p) => Number(p.y || 0)));
      const span = Math.max(1, this.points.length - 1);
      return this.points.map((p, idx) => ({
        ...p,
        cx: pad + (idx / span) * (w - pad * 2),
        cy: h - pad - (Number(p.y || 0) / maxY) * (h - pad * 2),
      }));
    },
    pathData() {
      if (!this.coords.length) return "";
      return this.coords.map((p, idx) => `${idx ? "L" : "M"}${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join(" ");
    },
  },
  template: `
    <div class="stat-chart line-chart">
      <svg viewBox="0 0 640 200" role="img" aria-label="卷子得分趋势">
        <line x1="28" y1="172" x2="612" y2="172" class="axis"/>
        <line x1="28" y1="28" x2="28" y2="172" class="axis"/>
        <path v-if="pathData" :d="pathData" :stroke="color || '#5b6f57'" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <circle v-for="p in coords" :key="p.x + p.y" :cx="p.cx" :cy="p.cy" r="4" :fill="color || '#5b6f57'">
          <title>{{ p.x }} · {{ p.y }}%</title>
        </circle>
        <text v-if="!coords.length" x="320" y="100" text-anchor="middle" class="chart-empty">还没有答题记录</text>
      </svg>
    </div>
  `,
});

app.component("PieChart", {
  props: ["data"],
  computed: {
    total() {
      return (this.data || []).reduce((sum, x) => sum + Number(x.value || 0), 0);
    },
    segments() {
      let start = -90;
      return (this.data || []).filter((x) => Number(x.value || 0) > 0).map((x) => {
        const angle = (Number(x.value || 0) / Math.max(1, this.total)) * 360;
        const seg = { ...x, start, end: start + angle };
        start += angle;
        return seg;
      });
    },
  },
  methods: {
    polar(cx, cy, r, angle) {
      const rad = (angle - 90) * Math.PI / 180;
      return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
    },
    segmentPath(seg) {
      const cx = 90;
      const cy = 90;
      const outer = 72;
      const inner = 42;
      const s1 = this.polar(cx, cy, outer, seg.end);
      const e1 = this.polar(cx, cy, outer, seg.start);
      const s2 = this.polar(cx, cy, inner, seg.start);
      const e2 = this.polar(cx, cy, inner, seg.end);
      const large = seg.end - seg.start > 180 ? 1 : 0;
      return `M ${s1.x} ${s1.y} A ${outer} ${outer} 0 ${large} 0 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${inner} ${inner} 0 ${large} 1 ${e2.x} ${e2.y} Z`;
    },
  },
  template: `
    <div class="stat-chart pie-wrap">
      <svg viewBox="0 0 180 180" class="pie-chart" role="img" aria-label="单词状态分布">
        <circle cx="90" cy="90" r="72" fill="#eee9df"/>
        <path v-for="seg in segments" :key="seg.label" :d="segmentPath(seg)" :fill="seg.color">
          <title>{{ seg.label }} · {{ seg.value }}</title>
        </path>
        <circle cx="90" cy="90" r="40" fill="white"/>
        <text x="90" y="86" text-anchor="middle" class="pie-total">{{ total }}</text>
        <text x="90" y="104" text-anchor="middle" class="pie-caption">单词</text>
      </svg>
      <div class="pie-legend">
        <span v-for="item in data" :key="item.label"><i :style="{ background: item.color }"></i>{{ item.label }} {{ item.value }}</span>
      </div>
    </div>
  `,
});

/* -------------------- 统计弹窗 -------------------- */
app.component("StatsView", {
  props: ["state", "users", "allUsernames", "me"],
  computed: {
    summaryByUser() {
      const out = {};
      for (const u of this.allUsernames) {
        out[u] = {
          checkins: this.state.checkins.filter((c) => c.owner === u).length,
          vocab: this.state.checkins
            .filter((c) => c.owner === u && c.type === "vocab")
            .reduce((sum, c) => sum + (Number(c.amount) || 0), 0),
          mastered: this.state.vocab.filter((v) => v.owner === u && v.status === "mastered").length,
          attempts: this.state.examAttempts.filter((a) => a.owner === u).length,
          math: this.state.math.filter((m) => m.owner === u).length,
          wrong: this.state.wrongQuestions.filter((w) => w.owner === u && !w.mastered).length,
        };
      }
      return out;
    },
    qskyHeatmap() { return this.heatmapFor("qsky"); },
    liutaoHeatmap() { return this.heatmapFor("liutao"); },
    paperScoreLine() {
      return this.state.examAttempts
        .filter((a) => a.owner === this.me)
        .slice()
        .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))
        .slice(-30)
        .map((a) => ({ x: a.createdAt.slice(0, 10), y: Number(a.score.percent || 0) }));
    },
    vocabStatusPie() {
      const rows = this.state.vocab.filter((v) => v.owner === this.me);
      const count = { learning: 0, mastered: 0, again: 0 };
      for (const v of rows) count[v.status] = (count[v.status] || 0) + 1;
      return [
        { label: "学习中", value: count.learning || 0, color: "#d8d1a6" },
        { label: "已掌握", value: count.mastered || 0, color: "#a8b5a0" },
        { label: "再背", value: count.again || 0, color: "#e8b4b8" },
      ];
    },
  },
  methods: {
    heatmapFor(owner) {
      const out = {};
      for (const c of this.state.checkins) {
        if (c.owner !== owner || !c.createdAt) continue;
        const key = c.createdAt.slice(0, 10);
        out[key] = (out[key] || 0) + 1;
      }
      return out;
    },
  },
  template: `
    <div class="stats-view">
      <h3>📊 双人统计</h3>
      <div class="stats-section">
        <h4>365 天打卡热力图</h4>
        <heatmap-chart label="Qsky" :data="qskyHeatmap" :color="users.qsky.color"/>
        <heatmap-chart label="我爱刘涛" :data="liutaoHeatmap" :color="users.liutao.color"/>
      </div>
      <div class="stats-section">
        <h4>卷子得分趋势（我）</h4>
        <line-chart :data="paperScoreLine" color="#5b6f57"/>
      </div>
      <div class="stats-section">
        <h4>单词状态分布（我）</h4>
        <pie-chart :data="vocabStatusPie"/>
      </div>
      <table class="cf-table">
        <thead><tr><th>指标</th><th v-for="u in allUsernames" :key="u" :style="{ color: users[u].color }">{{ users[u].displayName }}</th></tr></thead>
        <tbody>
          <tr><td>总打卡数</td><td v-for="u in allUsernames" :key="u">{{ summaryByUser[u].checkins }}</td></tr>
          <tr><td>累计学词</td><td v-for="u in allUsernames" :key="u">{{ summaryByUser[u].vocab }}</td></tr>
          <tr><td>已掌握</td><td v-for="u in allUsernames" :key="u">{{ summaryByUser[u].mastered }}</td></tr>
          <tr><td>卷子答题次数</td><td v-for="u in allUsernames" :key="u">{{ summaryByUser[u].attempts }}</td></tr>
          <tr><td>数学题</td><td v-for="u in allUsernames" :key="u">{{ summaryByUser[u].math }}</td></tr>
          <tr><td>未掌握错题</td><td v-for="u in allUsernames" :key="u">{{ summaryByUser[u].wrong }}</td></tr>
        </tbody>
      </table>
    </div>
  `,
});

/* -------------------- 图片附件器（卷子答题用） -------------------- */
app.component("ImageAttacher", {
  props: ["images", "onFiles"],
  setup(props) {
    function handleFileInput(evt) {
      if (evt.target.files.length) props.onFiles(evt.target.files);
      evt.target.value = "";
    }
    function handlePaste(evt) {
      const items = evt.clipboardData && evt.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) if (it.kind === "file") files.push(it.getAsFile());
      if (files.length) { evt.preventDefault(); props.onFiles(files); }
    }
    return { handleFileInput, handlePaste };
  },
  template: `
    <div class="attacher" @paste="handlePaste">
      <label class="link">+ 图片<input type="file" accept="image/*" multiple hidden @change="handleFileInput"/></label>
      <span class="muted small">已选 {{ images.length }} 张</span>
      <div class="img-row">
        <img v-for="img in images" :key="img" :src="img"/>
      </div>
    </div>
  `,
});

app.mount("#app");
