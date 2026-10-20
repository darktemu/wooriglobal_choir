/* 찬양대 연습노트 — 앱 본체 (여러 성가대 · 로그인 필수 · 빌드 과정 없이 그대로 배포) */
(function () {
  "use strict";

  var PARTS = [["all", "전체"], ["S", "소프라노"], ["A", "알토"], ["T", "테너"], ["B", "베이스"]];
  var PART_NAME = { all: "전체", S: "소프라노", A: "알토", T: "테너", B: "베이스" };
  var LEVELS = ["하", "중하", "중", "중상", "상"];
  var ROLE_NAME = { admin: "관리자", editor: "편집자", member: "대원" };
  var DOW = ["일", "월", "화", "수", "목", "금", "토"];

  var app = document.getElementById("app");
  var CFG = window.CHOIR_CONFIG || {};
  var sb = null;
  if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  }

  /* ---------- storage helpers ---------- */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ---------- state ---------- */
  var session = null;                 // Supabase 로그인 세션
  var profile = null;                 // {id, display_name, part, choir_id}
  var choir = null;                   // {id, name, notice}
  var role = null;                    // admin | editor | member
  var state = { songs: [], services: [] };
  var choirList = null;               // list_choirs() 결과
  var members = null;                 // 대원 목록 (설정 화면)
  var prefs = lsGet("choir.prefs", { done: {}, installDismissed: false });
  if (!prefs.done) prefs.done = {};
  var ui = {
    screen: "boot",                   // boot | setup | auth | recovery | pick | app
    authTab: "login",                 // login | signup | forgot
    view: "week", selDate: null, songId: null, q: "", pub: "", partTab: {},
    admin: false, editSong: null, busy: false, offline: false, loadError: "", choirQ: ""
  };
  var loginInFlight = false;

  function uid() { return session && session.user ? session.user.id : null; }
  function canEdit() { return role === "admin" || role === "editor"; }
  function myPart() { return (profile && profile.part) || "all"; }
  function cacheKey() { return "choir.cache.v2." + (uid() || "anon"); }

  /* ---------- dates & text ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isoOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function today() { return isoOf(new Date()); }
  function parseD(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtLong(s) { var d = parseD(s); return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + DOW[d.getDay()] + ")"; }
  function fmtShort(s) { var d = parseD(s); return (d.getMonth() + 1) + "/" + d.getDate(); }
  function daysUntil(s) { return Math.round((parseD(s) - parseD(today())) / 86400000); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { u = String(u || "").trim(); return /^https?:\/\//i.test(u) ? u : ""; }
  function ytId(u) { var m = String(u || "").match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/); return m ? m[1] : null; }
  function fmtTime(t) { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ":" + pad(t % 60); }

  function songById(id) { for (var i = 0; i < state.songs.length; i++) if (state.songs[i].id === id) return state.songs[i]; return null; }
  function servicesSorted() { return state.services.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.slot < b.slot ? -1 : 1); }); }
  function dates() { var seen = {}, out = []; servicesSorted().forEach(function (s) { if (!seen[s.date]) { seen[s.date] = 1; out.push(s.date); } }); return out; }
  function nextDate() { var ds = dates(), t = today(); for (var i = 0; i < ds.length; i++) if (ds[i] >= t) return ds[i]; return ds[ds.length - 1] || null; }
  function hasLinks(p) { return !!(p && (safeUrl(p.audio) || safeUrl(p.youtube) || safeUrl(p.source))); }
  function normParts(parts) { var out = {}; PARTS.forEach(function (p) { var x = (parts && parts[p[0]]) || {}; out[p[0]] = { audio: x.audio || "", youtube: x.youtube || "", source: x.source || "" }; }); return out; }
  function blankSong() { return { id: "", title: "", composer: "", publisher: "", collection: "", page: "", level: "중", memo: "", analysis: { key: "", meter: "", tempo: "", voicing: "SATB", measures: "", notes: "" }, parts: normParts({}) }; }

  /* ---------- errors ---------- */
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, ms); })]);
  }
  function explainDbError(e) {
    var m = (e && e.message) || "", code = e && e.code;
    if (/not_admin/.test(m)) return "관리자만 할 수 있어요.";
    if (/cannot_change_self/.test(m)) return "자기 자신의 역할은 바꿀 수 없어요.";
    if (/last_admin/.test(m)) return "마지막 관리자는 탈퇴할 수 없어요. 다른 대원을 관리자로 지정한 뒤 탈퇴하세요.";
    if (/invalid_name/.test(m)) return "성가대 이름을 1~60자로 입력하세요.";
    if (/choir_not_found/.test(m)) return "없어진 성가대예요. 목록을 새로 고쳐 주세요.";
    if (code === "42501" && /permission denied for (table|schema|function)/i.test(m)) return "데이터베이스 권한(GRANT)이 없습니다. Supabase SQL Editor에서 schema.sql 전체를 다시 실행하세요.";
    if (code === "42501" || /row-level security/i.test(m)) return "편집 권한이 없어 저장되지 않았어요. 관리자에게 편집자 지정을 요청하세요.";
    if (code === "42P01" || code === "PGRST202" || /does not exist|could not find the function/i.test(m)) return "데이터베이스 설정이 최신이 아닙니다. Supabase SQL Editor에서 schema.sql 전체를 실행하세요.";
    if (/JWT|401/i.test(m)) return "로그인이 만료됐어요. 다시 로그인하세요.";
    if (m === "timeout") return "서버 응답이 없어요. 잠시 후 다시 시도하세요.";
    return "오류: " + (m || code || "알 수 없음");
  }
  function explainAuthError(e) {
    var m = (e && e.message) || "";
    if (/invalid login credentials/i.test(m)) return "이메일 또는 비밀번호가 맞지 않아요.";
    if (/email not confirmed/i.test(m)) return "이메일 확인이 켜져 있어요. Supabase에서 ‘Confirm email’을 끄면 바로 로그인됩니다.";
    if (/already registered|already been registered/i.test(m)) return "이미 가입된 이메일이에요. 로그인해 주세요.";
    if (/password.*(at least|short|characters)/i.test(m)) return "비밀번호는 6자 이상으로 정해 주세요.";
    if (/signups? not allowed|signup is disabled/i.test(m)) return "가입이 꺼져 있어요. Supabase에서 ‘Allow new users to sign up’을 켜 주세요.";
    if (/rate limit/i.test(m)) return "요청이 너무 잦아요. 잠시 후 다시 시도하세요.";
    if (/valid email|invalid email|unable to validate email/i.test(m)) return "이메일 주소 형식을 확인해 주세요.";
    if (m === "timeout") return "서버 응답이 없어요. config.js의 Supabase 주소를 확인하거나 잠시 후 다시 시도하세요.";
    if (/fetch|network/i.test(m)) return "인터넷 연결을 확인한 뒤 다시 시도하세요.";
    return "처리하지 못했어요: " + m;
  }
  function rq(p) { return withTimeout(p, 15000).then(function (r) { if (r && r.error) throw r.error; return r ? r.data : null; }); }

  /* ---------- data loading ---------- */
  function applyChoirData(d) {
    profile = d.profile; choir = d.choir; role = d.role;
    state.songs = (d.songs || []).map(function (s) { s.analysis = s.analysis || {}; s.parts = normParts(s.parts); return s; });
    state.services = (d.services || []).map(function (r) { return { id: r.id, date: r.date, slot: r.slot, songId: r.song_id || r.songId }; });
  }
  function loadProfile() {
    return rq(sb.from("profiles").select("id, display_name, part, choir_id").eq("id", uid()).maybeSingle());
  }
  function loadChoirData(p) {
    var c = p.choir_id;
    return Promise.all([
      rq(sb.from("choirs").select("id, name, notice").eq("id", c).maybeSingle()),
      rq(sb.from("memberships").select("role").eq("choir_id", c).eq("user_id", uid()).maybeSingle()),
      rq(sb.from("songs").select("*").eq("choir_id", c).order("title")),
      rq(sb.from("services").select("*").eq("choir_id", c).order("date"))
    ]).then(function (r) {
      return { profile: p, choir: r[0], role: r[1] && r[1].role, songs: r[2], services: r[3] };
    });
  }
  // 로그인 후 전체 불러오기 → 알맞은 화면으로
  function loadAll() {
    ui.loadError = "";
    return loadProfile().then(function (p) {
      if (!p) { profile = { id: uid(), display_name: "", part: "all", choir_id: null }; return enterPick(); }
      profile = p;
      if (!p.choir_id) return enterPick();
      return loadChoirData(p).then(function (d) {
        if (!d.choir || !d.role) { profile.choir_id = null; return enterPick(); }
        applyChoirData(d); lsSet(cacheKey(), d); ui.offline = false;
        if (ui.screen !== "app") { ui.screen = "app"; ui.view = "week"; ui.selDate = null; }
        render();
      });
    }).catch(function (e) {
      var cached = lsGet(cacheKey(), null);
      if (!(e && e.code) && cached && cached.choir) {   // 네트워크 문제 → 마지막 내용
        applyChoirData(cached); ui.offline = true; ui.screen = "app"; render(); return;
      }
      ui.loadError = explainDbError(e);
      if (ui.screen !== "app") ui.screen = "pick";
      render();
    });
  }
  function reloadChoir() {
    if (!profile || !profile.choir_id) return loadAll();
    return loadChoirData(profile).then(function (d) {
      if (!d.choir || !d.role) return loadAll();
      applyChoirData(d); lsSet(cacheKey(), d); ui.offline = false; ui.loadError = "";
    });
  }
  function enterPick() {
    ui.screen = "pick"; choir = null; role = null; state = { songs: [], services: [] };
    render();
    return loadChoirList();
  }
  function loadChoirList() {
    choirList = null;
    return rq(sb.rpc("list_choirs")).then(function (rows) { choirList = rows || []; render(); })
      .catch(function (e) { choirList = []; ui.loadError = explainDbError(e); render(); });
  }
  function loadMembers() {
    if (!choir) return;
    rq(sb.from("memberships").select("user_id, role, joined_at, profiles(display_name, part)").eq("choir_id", choir.id).order("joined_at"))
      .then(function (rows) { members = rows || []; if (ui.view === "settings") render(); })
      .catch(function (e) { members = []; toast(explainDbError(e)); });
  }

  /* ---------- audio tools: metronome & starting chord ---------- */
  var actx = null;
  function ctx() { if (!actx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return null; actx = new C(); } if (actx.state === "suspended") actx.resume(); return actx; }
  var metro = { songId: null, bpm: 80, bpmFor: null, timer: null, beat: 0, beats: 4 };
  function tempoOf(s) { var m = String(s.analysis && s.analysis.tempo || "").match(/(\d{2,3})/); return m ? +m[1] : 80; }
  function beatsOf(s) { var m = String(s.analysis && s.analysis.meter || "").match(/(\d+)\s*\//); return m ? +m[1] : 4; }
  function bpmFor(s) { return metro.bpmFor === s.id ? metro.bpm : tempoOf(s); }
  function click(accent) {
    var c = ctx(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = "square"; o.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.25 : 0.14, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.08);
  }
  function metroStop() { if (metro.timer) clearInterval(metro.timer); var id = metro.songId; metro.timer = null; metro.songId = null; if (id) syncMetroUI(id); }
  function metroStart(s) {
    var prev = metro.songId; if (metro.timer) clearInterval(metro.timer);
    if (metro.bpmFor !== s.id) { metro.bpm = tempoOf(s); metro.bpmFor = s.id; }
    metro.songId = s.id; metro.beat = 0; metro.beats = beatsOf(s);
    var tick = function () { click(metro.beat % metro.beats === 0); metro.beat++; };
    tick(); metro.timer = setInterval(tick, 60000 / metro.bpm);
    if (prev && prev !== s.id) syncMetroUI(prev);
    syncMetroUI(s.id);
  }
  function syncMetroUI(id) {
    var s = songById(id); if (!s) return;
    var on = metro.songId === id;
    app.querySelectorAll('[data-act="metro"][data-id="' + id + '"]').forEach(function (b) { b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); b.textContent = on ? "■ 메트로놈 정지" : "♩ 메트로놈"; });
    app.querySelectorAll('[data-bpm="' + id + '"]').forEach(function (el) { el.textContent = "♩=" + bpmFor(s); });
  }
  var NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function playKey(s) {
    var k = String(s.analysis && s.analysis.key || "").trim();
    var m = k.match(/^([A-Ga-g])\s*(b|♭|#|♯)?\s*(m(?!aj)|minor|단조)?/);
    if (!m) { toast("곡 분석에 조성을 입력하면 첫음을 들려드려요."); return; }
    var c = ctx(); if (!c) return;
    var semi = NOTE[m[1].toUpperCase()] + (m[2] === "b" || m[2] === "♭" ? -1 : m[2] ? 1 : 0);
    var minor = !!m[3] || /^[a-g]/.test(k);
    var root = 261.63 * Math.pow(2, (((semi % 12) + 12) % 12) / 12);
    var iv = minor ? [0, 3, 7, 12] : [0, 4, 7, 12], t0 = c.currentTime + 0.02;
    iv.forEach(function (x, i) { tone(root * Math.pow(2, x / 12), t0 + i * 0.35, 0.5); });
    iv.slice(0, 3).forEach(function (x) { tone(root * Math.pow(2, x / 12), t0 + 1.5, 1.6); });
  }
  function tone(f, t, d) {
    var c = actx, o = c.createOscillator(), g = c.createGain();
    o.type = "triangle"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + d + 0.05);
  }

  /* ---------- icons ---------- */
  var ICON = {
    week: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12.5l4 4 10-10"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    yt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/></svg>',
    src: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
  };

  /* ---------- render pieces ---------- */
  function levelPill(l) { return l ? '<span class="lv lv-' + esc(l) + '">난이도 ' + esc(l) + "</span>" : ""; }
  function rolePill(r) { return r ? '<span class="role role-' + esc(r) + '">' + esc(ROLE_NAME[r] || r) + "</span>" : ""; }
  function bookLine(s) {
    var bits = [];
    if (s.collection) bits.push(esc(s.collection)); else if (s.publisher) bits.push(esc(s.publisher));
    if (s.page) bits.push("p." + esc(s.page));
    return bits.join(" · ");
  }
  function player(url) {
    // https 음원만 앱 안에서 재생 (http 음원은 보안 정책상 새 창으로만 열림)
    return '<div class="player"><audio controls preload="none" src="' + esc(url) + '"></audio><div class="pctl">'
      + '<span class="seg" role="group" aria-label="재생 속도">' + [0.75, 0.9, 1, 1.1].map(function (r) { return '<button data-act="rate" data-r="' + r + '" aria-pressed="' + (r === 1) + '">' + r + "x</button>"; }).join("") + "</span>"
      + '<button class="tool" data-act="ab">구간 시작(A)</button><span class="abtxt"></span></div></div>';
  }
  function practice(song) {
    var tab = ui.partTab[song.id] || myPart();
    var p = song.parts[tab];
    var h = '<div><p class="block-h">파트별 연습</p><div class="parts" role="tablist" aria-label="파트 선택">';
    PARTS.forEach(function (pp) {
      h += '<button class="pt p-' + pp[0] + '" role="tab" aria-selected="' + (tab === pp[0]) + '" data-act="part" data-id="' + esc(song.id) + '" data-part="' + pp[0] + '"' + (hasLinks(song.parts[pp[0]]) ? "" : ' title="링크 없음"') + ">"
        + (pp[0] !== "all" ? "<i></i>" : "") + pp[1] + (myPart() === pp[0] && pp[0] !== "all" ? ' <span class="mine">내 파트</span>' : "") + "</button>";
    });
    h += "</div>";
    if (hasLinks(p)) {
      var au = safeUrl(p.audio), yu = safeUrl(p.youtube), vid = ytId(yu);
      if (/^https:/i.test(au)) h += player(au);
      if (vid) h += '<div class="ytbox"><button class="yt" data-act="yt" data-vid="' + esc(vid) + '" aria-label="유튜브 영상 재생"><img src="https://i.ytimg.com/vi/' + esc(vid) + '/hqdefault.jpg" alt="" loading="lazy"><span>▶ 영상 재생</span></button></div>';
      h += '<div class="links">';
      if (au) h += '<a class="lk" href="' + esc(au) + '" target="_blank" rel="noopener">' + ICON.play + (/^https:/i.test(au) ? "음원 새 창" : "음원 듣기") + "</a>";
      if (yu) h += '<a class="lk" href="' + esc(yu) + '" target="_blank" rel="noopener">' + ICON.yt + "유튜브에서 열기</a>";
      if (safeUrl(p.source)) h += '<a class="lk" href="' + esc(safeUrl(p.source)) + '" target="_blank" rel="noopener">' + ICON.src + "출처 연습실</a>";
      h += "</div>";
    } else {
      var alt = (tab !== "all" && hasLinks(song.parts.all)) ? " ‘전체’ 탭의 자료로 연습해 보세요." : "";
      h += '<p class="empty">이 파트에 등록된 연습 자료가 아직 없습니다.' + alt + "</p>";
    }
    h += "</div>";
    var on = metro.songId === song.id, key = song.analysis.key;
    h += '<div class="tools">'
      + '<button class="tool' + (on ? " on" : "") + '" data-act="metro" data-id="' + esc(song.id) + '" aria-pressed="' + on + '">' + (on ? "■ 메트로놈 정지" : "♩ 메트로놈") + "</button>"
      + '<span class="bpm" aria-label="빠르기 조절"><button data-act="bpm" data-id="' + esc(song.id) + '" data-d="-4" aria-label="느리게">−</button><span data-bpm="' + esc(song.id) + '">♩=' + bpmFor(song) + '</span><button data-act="bpm" data-id="' + esc(song.id) + '" data-d="4" aria-label="빠르게">+</button></span>'
      + '<button class="tool" data-act="key" data-id="' + esc(song.id) + '">♪ 첫음 듣기' + (key ? ' <span class="num">' + esc(key) + "</span>" : "") + "</button>"
      + '<label class="done"><input type="checkbox" data-act="done" data-id="' + esc(song.id) + '"' + (prefs.done[song.id] ? " checked" : "") + "> 연습 완료</label>"
      + "</div>";
    return h;
  }
  function analysis(song) {
    var a = song.analysis;
    var cells = [["시작 페이지", song.page ? "p." + song.page : ""], ["조성", a.key], ["박자", a.meter], ["빠르기", a.tempo], ["편성", a.voicing], ["마디수", a.measures ? a.measures + "마디" : ""]];
    if (!cells.some(function (c) { return c[1]; }) && !a.notes) return '<div><p class="block-h">곡 분석</p><p class="empty">아직 분석이 등록되지 않았습니다.</p></div>';
    var h = '<div><p class="block-h">곡 분석</p><dl class="an">';
    cells.forEach(function (c) { h += "<div><dt>" + c[0] + "</dt><dd>" + (c[1] ? esc(c[1]) : "—") + "</dd></div>"; });
    h += "</dl>";
    if (a.notes) h += '<p class="an-notes">' + esc(a.notes).replace(/(m\.\s?\d+(?:-\d+)?)/g, "<code>$1</code>") + "</p>";
    return h + "</div>";
  }
  function songCard(song, svc) {
    var h = '<article class="song"><div><div class="slot">' + (svc ? '<span class="svc">' + esc(svc.slot) + "</span>" : "") + "<span>" + bookLine(song) + "</span>" + levelPill(song.level) + "</div>";
    h += '<h3 style="margin-top:8px"><button data-act="song" data-id="' + esc(song.id) + '">' + esc(song.title) + "</button></h3>";
    if (song.composer) h += '<p class="composer">작곡 ' + esc(song.composer) + "</p>";
    h += "</div>";
    if (song.memo) h += '<p class="memo">' + esc(song.memo) + "</p>";
    return h + practice(song) + analysis(song) + "</article>";
  }

  /* ---------- install prompt ---------- */
  var deferredPrompt = null;
  var isStandalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredPrompt = e; if (ui.screen === "app" && ui.view === "week") render(); });
  function installBanner() {
    if (isStandalone || prefs.installDismissed || (!deferredPrompt && !isIOS)) return "";
    var msg = deferredPrompt ? "<b>홈 화면에 설치</b>하면 앱처럼 바로 열 수 있어요."
      : "Safari 아래쪽 <b>공유 버튼 → 홈 화면에 추가</b>를 누르면 앱처럼 쓸 수 있어요.";
    return '<div class="install"><p>' + msg + "</p>" + (deferredPrompt ? '<button class="btn primary mini" data-act="install">설치</button>' : "") + '<button class="btn mini" data-act="install-x" aria-label="안내 닫기">닫기</button></div>';
  }

  /* ---------- screens before the app ---------- */
  function shell(inner) {
    return '<div class="gate"><div class="gate-card"><div class="gate-brand"><img src="/icons/icon-192.png" alt="" width="44" height="44"><div><small>성가대 연습실</small><b>찬양대 연습노트</b></div></div>' + inner + "</div></div>";
  }
  function viewSetup() {
    return shell('<p class="gate-lead">아직 서버가 연결되지 않았어요.</p><p class="empty" style="margin:0">관리자는 <code>config.js</code>에 Supabase 주소와 키를 넣고 다시 배포하세요. 자세한 방법은 README.md에 있습니다.</p>');
  }
  function viewAuth() {
    var t = ui.authTab, h = "";
    h += '<div class="seg wide" role="tablist" aria-label="로그인 또는 가입">'
      + '<button role="tab" data-act="auth-tab" data-tab="login" aria-pressed="' + (t === "login") + '">로그인</button>'
      + '<button role="tab" data-act="auth-tab" data-tab="signup" aria-pressed="' + (t === "signup") + '">가입하기</button></div>';
    if (t === "login") {
      h += '<form id="loginform" class="gate-form">'
        + '<label>이메일<input id="a-email" type="email" autocomplete="username" required></label>'
        + '<label>비밀번호<input id="a-pass" type="password" autocomplete="current-password" required></label>'
        + '<button class="btn primary big" type="submit">로그인</button>'
        + '<button class="linkbtn" type="button" data-act="auth-tab" data-tab="forgot">비밀번호를 잊었어요</button></form>';
    } else if (t === "signup") {
      h += '<form id="signupform" class="gate-form">'
        + '<label>이름<input id="a-name" autocomplete="name" maxlength="30" placeholder="예: 김알토" required></label>'
        + '<fieldset class="partpick"><legend>내 파트</legend>' + [["S", "소프라노"], ["A", "알토"], ["T", "테너"], ["B", "베이스"], ["all", "미정"]].map(function (p, i) {
          return '<label><input type="radio" name="a-part" value="' + p[0] + '"' + (i === 4 ? " checked" : "") + "><span>" + p[1] + "</span></label>";
        }).join("") + "</fieldset>"
        + '<label>이메일<input id="a-email" type="email" autocomplete="username" required></label>'
        + '<label>비밀번호 (6자 이상)<input id="a-pass" type="password" autocomplete="new-password" minlength="6" required></label>'
        + '<button class="btn primary big" type="submit">가입하고 시작하기</button>'
        + '<p class="empty" style="margin:0">가입하면 바로 승인됩니다. 다음 화면에서 성가대를 고르세요.</p></form>';
    } else {
      h += '<form id="forgotform" class="gate-form"><p class="empty" style="margin:0">가입한 이메일로 비밀번호 재설정 링크를 보내 드려요.</p>'
        + '<label>이메일<input id="a-email" type="email" autocomplete="username" required></label>'
        + '<button class="btn primary big" type="submit">재설정 메일 보내기</button>'
        + '<button class="linkbtn" type="button" data-act="auth-tab" data-tab="login">로그인으로 돌아가기</button></form>';
    }
    return shell(h);
  }
  function viewRecovery() {
    return shell('<form id="recoveryform" class="gate-form"><p class="gate-lead">새 비밀번호를 정해 주세요.</p>'
      + '<label>새 비밀번호 (6자 이상)<input id="a-pass" type="password" autocomplete="new-password" minlength="6" required></label>'
      + '<button class="btn primary big" type="submit">비밀번호 바꾸기</button></form>');
  }
  function choirPicker(inApp) {
    var h = "";
    if (ui.loadError) h += '<div class="notice"><b>오류</b><span>' + esc(ui.loadError) + "</span></div>";
    h += '<div class="search"><input id="cq" type="search" placeholder="성가대 이름 검색" value="' + esc(ui.choirQ) + '" aria-label="성가대 검색"></div>';
    h += '<ul class="list choirs" id="choirlist">' + choirRows() + "</ul>";
    h += '<div class="newchoir"><p class="block-h" style="margin:0">찾는 성가대가 없나요?</p><div class="row2"><input id="new-choir" maxlength="60" placeholder="예: 은평교회 할렐루야 찬양대" aria-label="새 성가대 이름"><button class="btn primary" data-act="create-choir">새 성가대 만들기</button></div>'
      + '<p class="empty" style="margin:0">교회 이름을 함께 쓰면 다른 성가대와 헷갈리지 않아요. 만든 사람이 관리자가 됩니다.</p></div>';
    if (!inApp) h += '<div class="btns" style="justify-content:space-between"><span class="empty" style="margin:0">' + esc((profile && profile.display_name) || "") + "님, 환영합니다</span>" + '<button class="btn mini" data-act="logout">로그아웃</button></div>';
    return h;
  }
  function choirRows() {
    if (choirList === null) return '<li><p class="empty" style="padding:12px 16px;margin:0">성가대 목록을 불러오는 중…</p></li>';
    var q = ui.choirQ.trim().toLowerCase();
    var rows = choirList.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) >= 0; });
    if (!rows.length) return '<li><p class="empty" style="padding:12px 16px;margin:0">' + (choirList.length ? "검색 결과가 없습니다." : "아직 등록된 성가대가 없어요. 아래에서 첫 성가대를 만들어 주세요.") + "</p></li>";
    var cur = profile && profile.choir_id;
    return rows.map(function (c) {
      var label = c.id === cur ? "지금 성가대" : c.is_member ? "이동" : "가입";
      return '<li><div class="row"><span class="t"><b>' + esc(c.name) + "</b><span>대원 " + c.member_count + "명" + (c.is_member ? " · 가입함" : "") + "</span></span>"
        + (c.id === cur ? '<span class="ok-mark">지금 성가대</span>' : '<button class="btn mini' + (c.is_member ? "" : " primary") + '" data-act="join-choir" data-id="' + esc(c.id) + '" data-name="' + esc(c.name) + '">' + label + "</button>")
        + "</div></li>";
    }).join("");
  }
  function viewPick() {
    return shell('<p class="gate-lead">함께할 성가대를 골라 주세요</p><p class="empty" style="margin:0 0 4px">고르면 바로 가입됩니다. 나중에 ‘설정’에서 바꿀 수 있어요.</p>' + choirPicker(false));
  }

  /* ---------- app views ---------- */
  function viewWeek() {
    var ds = dates(), nd = nextDate();
    if (!ui.selDate || ds.indexOf(ui.selDate) < 0) ui.selDate = nd;
    var h = installBanner();
    if (choir.notice) h += '<div class="notice"><b>공지</b><span>' + esc(choir.notice) + "</span></div>";
    if (nd) {
      var svcs = servicesSorted().filter(function (s) { return s.date === nd; });
      var dd = daysUntil(nd), when = dd === 0 ? "오늘" : dd > 0 ? dd + "일 남음" : "지난 예배";
      var titles = svcs.map(function (s) { var so = songById(s.songId); return so ? so.title : ""; }).filter(Boolean);
      h += '<section class="hero" aria-label="다음 예배"><div class="eyebrow">다음 찬양 · ' + when + "</div><h1>" + esc(titles.join(" / ") || "선곡 준비 중") + '</h1><p class="when">' + fmtLong(nd) + " · " + esc(svcs.map(function (s) { return s.slot; }).join(", ")) + '</p><p class="count">' + esc(choir.name) + "</p></section>";
    }
    h += '<section style="display:flex;flex-direction:column;gap:12px"><div class="sec-title"><h2>예배별 선곡</h2><p>날짜를 눌러 그날 부를 곡을 확인하세요</p></div>';
    if (ds.length) {
      h += '<div class="strip" id="strip">';
      var t = today();
      ds.forEach(function (d) {
        var svcs = state.services.filter(function (s) { return s.date === d; });
        var sub = svcs.length > 1 ? svcs.length + "회 예배" : (svcs[0] ? svcs[0].slot : "");
        h += '<button class="chip' + (d < t ? " past" : "") + (d === nd ? " next" : "") + '" data-act="date" data-date="' + d + '" aria-pressed="' + (d === ui.selDate) + '"><b>' + fmtShort(d) + "</b><span>" + (d === nd ? "다음 · " : "") + esc(sub) + "</span></button>";
      });
      h += "</div>";
    }
    h += "</section>";
    if (ui.selDate) {
      h += '<section style="display:flex;flex-direction:column;gap:14px"><div class="sec-title"><h2>' + fmtLong(ui.selDate) + "</h2></div>";
      servicesSorted().filter(function (s) { return s.date === ui.selDate; }).forEach(function (s) { var so = songById(s.songId); if (so) h += songCard(so, s); });
      h += "</section>";
    } else {
      h += '<section class="panel"><p style="margin:0">아직 등록된 선곡이 없습니다.</p>'
        + (canEdit() ? '<p class="empty" style="margin:0">상단의 ‘편집’에서 곡을 추가하고 예배 날짜에 선곡하세요.</p><div class="btns" style="justify-content:flex-start"><button class="btn primary" data-act="admin">편집 시작</button></div>'
          : '<p class="empty" style="margin:0">지휘자나 편집자가 선곡을 올리면 여기에 보입니다.</p>') + "</section>";
    }
    return h;
  }

  function viewSongs() {
    var pubs = {};
    state.songs.forEach(function (s) { if (s.publisher) pubs[s.publisher] = (pubs[s.publisher] || 0) + 1; });
    var h = '<div class="sec-title"><h2>곡 목록</h2><p>총 <span class="pnum">' + state.songs.length + "</span>곡</p></div>";
    h += '<div class="search"><input id="q" type="search" placeholder="곡명·작곡가·악보집 검색" value="' + esc(ui.q) + '" aria-label="곡 검색"></div>';
    h += '<div class="filters"><button class="fchip" data-act="pub" data-pub="" aria-pressed="' + !ui.pub + '">전체</button>';
    Object.keys(pubs).sort().forEach(function (p) { h += '<button class="fchip" data-act="pub" data-pub="' + esc(p) + '" aria-pressed="' + (ui.pub === p) + '">' + esc(p) + ' <span class="pnum">' + pubs[p] + "</span></button>"; });
    return h + '</div><ul class="list" id="songlist">' + songRows() + "</ul>";
  }
  function songRows() {
    var q = ui.q.trim().toLowerCase();
    var rows = state.songs.filter(function (s) {
      if (ui.pub && s.publisher !== ui.pub) return false;
      return !q || [s.title, s.composer, s.collection, s.publisher].join(" ").toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return a.title.localeCompare(b.title, "ko"); });
    if (!rows.length) return '<li><p class="empty" style="padding:12px 16px;margin:0">' + (state.songs.length ? "조건에 맞는 곡이 없습니다." : "아직 등록된 곡이 없습니다.") + "</p></li>";
    return rows.map(function (s) {
      var dots = PARTS.map(function (p) { return '<i class="' + (hasLinks(s.parts[p[0]]) ? p[0] : "") + '" title="' + p[1] + '"></i>'; }).join("");
      return '<li><button class="row" data-act="song" data-id="' + esc(s.id) + '"><span class="t"><b>' + esc(s.title) + "</b><span>" + [esc(s.composer), bookLine(s)].filter(Boolean).join(" · ") + "</span></span>"
        + (prefs.done[s.id] ? '<span class="ok-mark">완료</span>' : "") + levelPill(s.level) + '<span class="dots" aria-label="연습 자료가 있는 파트">' + dots + "</span></button></li>";
    }).join("");
  }

  function viewSong() {
    var s = songById(ui.songId);
    if (!s) { ui.view = "songs"; return viewSongs(); }
    var t = today(), hist = servicesSorted().filter(function (v) { return v.songId === s.id; });
    var h = '<button class="back" data-act="tab" data-view="songs">← 곡 목록</button>' + songCard(s, null);
    h += '<section class="panel"><p class="block-h" style="margin:0">연주 이력 <span class="pnum">' + hist.length + "</span>회</p>";
    h += hist.length ? '<ul class="hist">' + hist.map(function (v) { return '<li><time datetime="' + v.date + '">' + v.date.replace(/-/g, ".") + "</time><span>" + esc(v.slot) + (v.date >= t ? " · 예정" : "") + "</span></li>"; }).join("") + "</ul>"
      : '<p class="empty" style="margin:0">아직 예배에 배정되지 않았습니다.</p>';
    if (ui.admin) h += '<div class="btns"><button class="btn" data-act="edit-song" data-id="' + esc(s.id) + '">이 곡 수정</button></div>';
    return h + "</section>";
  }

  function viewMe() {
    var t = today(), upcoming = servicesSorted().filter(function (v) { return v.date >= t; });
    var ids = []; upcoming.forEach(function (v) { if (ids.indexOf(v.songId) < 0 && songById(v.songId)) ids.push(v.songId); });
    var done = ids.filter(function (id) { return prefs.done[id]; }).length;
    var pct = ids.length ? Math.round(done / ids.length * 100) : 0;
    var h = '<div class="sec-title"><h2>내 연습</h2><p>' + esc(PART_NAME[myPart()]) + " 파트 · 연습 완료 표시는 이 기기에만 저장됩니다</p></div>";
    h += '<section class="panel"><div class="sec-title"><p class="block-h" style="margin:0">다가오는 곡 준비도</p><p><span class="pnum">' + done + " / " + ids.length + '</span>곡</p></div><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>';
    if (ids.length) {
      h += '<ul class="list" style="border-radius:10px">';
      upcoming.forEach(function (v) {
        var s = songById(v.songId); if (!s) return;
        h += '<li><button class="row" data-act="song" data-id="' + esc(s.id) + '"><span class="t"><b>' + esc(s.title) + "</b><span>" + fmtShort(v.date) + " " + esc(v.slot) + "</span></span>" + (prefs.done[s.id] ? '<span class="ok-mark">완료</span>' : '<span class="empty" style="margin:0;font-size:12px">연습 전</span>') + "</button></li>";
      });
      h += "</ul>";
    } else h += '<p class="empty" style="margin:0">예정된 예배가 없습니다.</p>';
    return h + "</section>";
  }

  function viewSettings() {
    var email = session && session.user && session.user.email;
    var h = '<div class="sec-title"><h2>설정</h2><p>' + esc(email || "") + "</p></div>";
    // 내 정보
    h += '<section class="panel"><p class="block-h" style="margin:0">내 정보</p><div class="form">'
      + '<label class="full">이름<input id="p-name" maxlength="30" value="' + esc(profile.display_name) + '"></label></div>'
      + '<div class="mypart">' + [["S", "소프라노", "S"], ["A", "알토", "A"], ["T", "테너", "T"], ["B", "베이스", "B"], ["all", "전체", "♫"]].map(function (p) {
        return '<button data-act="mypart" data-part="' + p[0] + '" aria-pressed="' + (myPart() === p[0]) + '"><b>' + p[2] + "</b>" + p[1] + "</button>";
      }).join("") + "</div>"
      + '<p class="empty" style="margin:0">고른 파트가 모든 곡의 연습 탭에서 먼저 열립니다.</p>'
      + '<div class="btns"><button class="btn primary" data-act="save-profile">이름 저장</button></div></section>';
    // 성가대
    h += '<section class="panel"><p class="block-h" style="margin:0">내 성가대</p>'
      + '<div class="row" style="padding:0;cursor:default"><span class="t"><b>' + esc(choir.name) + "</b><span>내 역할</span></span>" + rolePill(role) + "</div>"
      + '<div class="btns" style="justify-content:flex-start"><button class="btn primary" data-act="tab" data-view="choirs">성가대 변경·추가</button><button class="btn danger" data-act="leave-choir">이 성가대 탈퇴</button></div></section>';
    // 대원 관리
    if (role === "admin" || role === "editor") {
      h += '<section class="panel"><div class="sec-title"><p class="block-h" style="margin:0">대원 <span class="pnum">' + (members ? members.length : "…") + "</span>명</p>"
        + (role === "admin" ? '<p>관리자는 역할을 바꾸거나 내보낼 수 있어요</p>' : "") + "</div>";
      if (members === null) h += '<p class="empty" style="margin:0">불러오는 중…</p>';
      else {
        h += '<ul class="adm-list">' + members.map(function (m) {
          var p = m.profiles || {}, me = m.user_id === uid();
          var ctl = (role === "admin" && !me)
            ? '<select data-act="role" data-id="' + esc(m.user_id) + '" aria-label="역할">' + ["member", "editor", "admin"].map(function (r) { return "<option value=\"" + r + "\"" + (m.role === r ? " selected" : "") + ">" + ROLE_NAME[r] + "</option>"; }).join("") + "</select>"
              + '<button class="btn danger mini" data-act="remove-member" data-id="' + esc(m.user_id) + '">내보내기</button>'
            : rolePill(m.role);
          return '<li><span class="grow">' + esc(p.display_name || "이름 없음") + (me ? " (나)" : "") + ' <span class="empty" style="font-size:12.5px">' + esc(PART_NAME[p.part] || "") + "</span></span>" + ctl + "</li>";
        }).join("") + "</ul>";
      }
      h += "</section>";
    }
    // 계정
    h += '<section class="panel"><p class="block-h" style="margin:0">계정</p><form id="pwform" class="form">'
      + '<label class="full">새 비밀번호 (6자 이상)<input id="p-pass" type="password" autocomplete="new-password" minlength="6"></label></form>'
      + '<div class="btns" style="justify-content:space-between"><button class="btn" data-act="logout">로그아웃</button><button class="btn" data-act="change-pass">비밀번호 바꾸기</button></div></section>';
    return h;
  }
  function viewChoirs() {
    return '<button class="back" data-act="tab" data-view="settings">← 설정</button><div class="sec-title"><h2>성가대 변경·추가</h2><p>고르면 바로 그 성가대로 이동합니다</p></div>'
      + '<section class="panel">' + choirPicker(true) + "</section>";
  }

  function viewAdmin() {
    var h = '<div class="sec-title"><h2>편집</h2><p>적용하면 바로 ' + esc(choir.name) + " 대원 모두에게 반영됩니다</p></div>";
    h += '<section class="panel"><p class="block-h" style="margin:0">성가대 정보</p><div class="form"><label class="full">성가대 이름<input id="f-choir" maxlength="60" value="' + esc(choir.name) + '"></label><label class="full">공지 (비우면 숨김)<textarea id="f-notice">' + esc(choir.notice) + '</textarea></label></div><div class="btns"><button class="btn primary" data-act="save-info">이름·공지 저장</button></div></section>';
    var sorted = state.songs.slice().sort(function (a, b) { return a.title.localeCompare(b.title, "ko"); });
    h += '<section class="panel"><p class="block-h" style="margin:0">예배 선곡 추가</p>';
    if (sorted.length) {
      h += '<div class="form">'
        + '<label>날짜<input id="f-date" type="date" value="' + esc(nextSunday()) + '"></label>'
        + '<label>예배<input id="f-slot" list="slots" value="낮예배"><datalist id="slots"><option value="낮예배"><option value="저녁예배"><option value="새벽예배"><option value="특별예배"></datalist></label>'
        + '<label class="full">곡<select id="f-song">' + sorted.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.title) + (s.composer ? " — " + esc(s.composer) : "") + "</option>"; }).join("") + "</select></label>"
        + '</div><div class="btns"><button class="btn primary" data-act="add-svc">선곡 추가</button></div>';
    } else h += '<p class="empty" style="margin:0">먼저 아래 ‘곡 관리’에서 곡을 추가하세요.</p>';
    h += '<ul class="adm-list">' + servicesSorted().slice().reverse().map(function (v) { var s = songById(v.songId); return "<li><time>" + v.date.replace(/-/g, ".") + '</time><span class="grow">' + esc(v.slot) + " · " + esc(s ? s.title : "(삭제된 곡)") + '</span><button class="btn danger mini" data-act="del-svc" data-id="' + esc(v.id) + '">삭제</button></li>'; }).join("") + "</ul></section>";
    h += '<section class="panel"><div class="sec-title"><p class="block-h" style="margin:0">곡 관리</p><button class="btn mini" data-act="new-song">+ 새 곡</button></div>';
    if (ui.editSong) h += songForm(ui.editSong);
    h += '<ul class="adm-list">' + sorted.map(function (s) { return '<li><span class="grow">' + esc(s.title) + ' <span class="empty" style="font-size:12.5px">' + esc(s.composer) + '</span></span><button class="btn mini" data-act="edit-song" data-id="' + esc(s.id) + '">수정</button><button class="btn danger mini" data-act="del-song" data-id="' + esc(s.id) + '">삭제</button></li>'; }).join("") + "</ul></section>";
    return h;
  }
  function nextSunday() { var d = parseD(today()); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return isoOf(d); }
  function songForm(s) {
    var a = s.analysis || {};
    function f(id, label, val, cls, type) { return "<label" + (cls ? ' class="' + cls + '"' : "") + ">" + label + '<input id="' + id + '" ' + (type ? 'type="' + type + '" ' : "") + 'value="' + esc(val) + '"></label>'; }
    var h = '<div class="form" id="songform" style="border:1px solid var(--line);border-radius:12px;padding:12px">';
    h += f("s-title", "곡명 *", s.title, "full") + f("s-composer", "작곡", s.composer) + f("s-publisher", "출판사", s.publisher) + f("s-collection", "악보집", s.collection) + f("s-page", "시작 페이지", s.page);
    h += '<label>난이도<select id="s-level">' + LEVELS.map(function (l) { return "<option" + (s.level === l ? " selected" : "") + ">" + l + "</option>"; }).join("") + "</select></label>";
    h += f("s-key", "조성 (예: Eb, F, Am)", a.key) + f("s-meter", "박자", a.meter) + f("s-tempo", "빠르기 (예: ♩=80)", a.tempo) + f("s-voicing", "편성", a.voicing) + f("s-measures", "마디수", a.measures);
    h += '<label class="full">지휘자 메모<textarea id="s-memo">' + esc(s.memo) + "</textarea></label>";
    h += '<label class="full">곡 분석 메모<textarea id="s-notes">' + esc(a.notes) + "</textarea></label>";
    PARTS.forEach(function (p) {
      var l = s.parts[p[0]] || {};
      h += "<fieldset><legend>" + p[1] + " 연습 자료</legend>" + f("l-" + p[0] + "-audio", "음원 링크 (https면 앱 안에서 재생)", l.audio, "", "url") + f("l-" + p[0] + "-youtube", "유튜브 링크", l.youtube, "", "url") + (p[0] === "all" ? f("l-all-source", "출처 페이지", l.source, "full", "url") : "") + "</fieldset>";
    });
    return h + '<div class="btns full"><button class="btn" data-act="cancel-song">취소</button><button class="btn primary" data-act="apply-song">' + (s.id ? "수정 적용" : "곡 추가") + "</button></div></div>";
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function readSongForm(base) {
    var parts = {};
    PARTS.forEach(function (p) { parts[p[0]] = { audio: val("l-" + p[0] + "-audio"), youtube: val("l-" + p[0] + "-youtube"), source: p[0] === "all" ? val("l-all-source") : "" }; });
    return {
      id: base.id, title: val("s-title"), composer: val("s-composer"), publisher: val("s-publisher"), collection: val("s-collection"), page: val("s-page"), level: val("s-level"), memo: val("s-memo"),
      analysis: { key: val("s-key"), meter: val("s-meter"), tempo: val("s-tempo"), voicing: val("s-voicing"), measures: val("s-measures"), notes: val("s-notes") },
      parts: parts
    };
  }

  /* ---------- shell ---------- */
  function render() {
    if (ui.screen !== "app") {
      document.title = "찬양대 연습노트";
      app.innerHTML = ({ boot: function () { return '<div class="boot">불러오는 중…</div>'; }, setup: viewSetup, auth: viewAuth, recovery: viewRecovery, pick: viewPick }[ui.screen])();
      bindSearch();
      return;
    }
    document.title = choir.name + " 연습노트";
    if (ui.view === "admin" && !(ui.admin && canEdit())) { ui.admin = false; ui.view = "week"; }
    var tabs = [["week", "이번 주", ICON.week], ["songs", "곡 목록", ICON.list], ["me", "내 연습", ICON.me], ["settings", "설정", ICON.gear]];
    var cur = ui.view === "song" ? "songs" : ui.view === "choirs" ? "settings" : ui.view;
    var h = '<header class="top"><div class="wrap"><button class="brand" data-act="tab" data-view="choirs" aria-label="성가대 변경"><small>성가대 연습실 · ' + esc(ROLE_NAME[role] || "") + "</small><b>" + esc(choir.name) + "</b></button>";
    h += '<nav class="tabs" aria-label="주요 화면">' + tabs.map(function (t) { return '<button class="tab" data-act="tab" data-view="' + t[0] + '"' + (cur === t[0] ? ' aria-current="page"' : "") + ">" + t[2] + "<span>" + t[1] + "</span></button>"; }).join("") + "</nav>";
    if (canEdit()) h += '<button class="editbtn" data-act="admin" aria-pressed="' + ui.admin + '">' + (ui.admin ? "편집 닫기" : "편집") + "</button>";
    h += '</div></header><main class="wrap">';
    if (ui.loadError) h += '<div class="notice"><b>연결 오류</b><span>' + esc(ui.loadError) + "</span></div>";
    else if (ui.offline) h += '<div class="notice"><b>오프라인</b><span>마지막으로 받아 둔 내용을 보여주고 있습니다.</span></div>';
    if (ui.admin && ui.view !== "admin") h += '<div class="btns" style="justify-content:flex-start"><button class="btn mini" data-act="tab" data-view="admin">선곡·곡 관리로 이동</button></div>';
    h += ({ week: viewWeek, songs: viewSongs, song: viewSong, me: viewMe, settings: viewSettings, choirs: viewChoirs, admin: viewAdmin }[ui.view] || viewWeek)();
    h += '<p class="foot">파트 연습 음원·영상·악보의 저작권은 각 출판사에 있습니다. 이 앱은 연습 편의를 위한 링크만 모아 둡니다.</p></main>';
    var old = document.getElementById("strip"), sx = old ? old.scrollLeft : null;
    app.innerHTML = h;
    var strip = document.getElementById("strip");
    if (strip) {
      if (sx != null) strip.scrollLeft = sx;
      else { var sel = strip.querySelector('[aria-pressed="true"]'); if (sel) strip.scrollLeft = Math.max(0, sel.offsetLeft - strip.offsetLeft - 40); }
    }
    bindSearch();
  }
  function bindSearch() {
    var q = document.getElementById("q");
    if (q) q.addEventListener("input", function () { ui.q = q.value; document.getElementById("songlist").innerHTML = songRows(); });
    var cq = document.getElementById("cq");
    if (cq) cq.addEventListener("input", function () { ui.choirQ = cq.value; document.getElementById("choirlist").innerHTML = choirRows(); });
  }
  function go(view) {
    ui.view = view;
    if (view === "settings") { members = null; if (canEdit()) loadMembers(); }
    if (view === "choirs") { ui.loadError = ""; loadChoirList(); }
    render(); window.scrollTo(0, 0);
  }
  var toastTimer = null;
  function toast(msg) {
    var t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, msg.length > 40 ? 7000 : 2800);
  }

  /* ---------- writes ---------- */
  function write(p, okMsg, after) {
    if (ui.busy) { toast("처리하는 중이에요. 잠시만 기다려 주세요."); return Promise.resolve(); }
    ui.busy = true;
    return rq(p).then(function () { return after ? after() : reloadChoir(); }).then(function () {
      ui.busy = false; render(); if (okMsg) toast(okMsg);
    }).catch(function (e) {
      ui.busy = false; console.error("저장 오류", e);
      toast(!navigator.onLine ? "인터넷 연결이 없어 저장하지 못했어요." : explainDbError(e));
      render();
    });
  }
  function songRow(s) { return { title: s.title, composer: s.composer, publisher: s.publisher, collection: s.collection, page: s.page, level: s.level, memo: s.memo, analysis: s.analysis, parts: s.parts, updated_at: new Date().toISOString() }; }
  function switchedChoir(msg) {
    return function () { ui.screen = "boot"; ui.admin = false; ui.partTab = {}; return loadAll().then(function () { if (msg) toast(msg); }); };
  }

  /* ---------- events ---------- */
  app.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    if (act === "done" || act === "role") return;
    if (act === "auth-tab") { ui.authTab = b.getAttribute("data-tab"); render(); var f = document.querySelector(".gate-form input"); if (f) f.focus(); }
    else if (act === "tab") go(b.getAttribute("data-view"));
    else if (act === "date") { ui.selDate = b.getAttribute("data-date"); render(); }
    else if (act === "song") { ui.songId = id; go("song"); }
    else if (act === "part") { ui.partTab[id] = b.getAttribute("data-part"); render(); }
    else if (act === "pub") { ui.pub = b.getAttribute("data-pub"); render(); }
    else if (act === "mypart") {
      var part = b.getAttribute("data-part"); profile.part = part; ui.partTab = {}; render();
      rq(sb.from("profiles").update({ part: part, updated_at: new Date().toISOString() }).eq("id", uid()))
        .then(function () { toast(PART_NAME[part] + " 파트로 정했어요."); }, function (e) { toast(explainDbError(e)); });
    }
    else if (act === "save-profile") {
      var nm = val("p-name"); if (!nm) { toast("이름을 입력하세요."); return; }
      write(sb.from("profiles").update({ display_name: nm, updated_at: new Date().toISOString() }).eq("id", uid()), "이름을 저장했어요.", function () { profile.display_name = nm; if (canEdit()) loadMembers(); });
    }
    else if (act === "change-pass") {
      var pw = document.getElementById("p-pass").value;
      if (pw.length < 6) { toast("비밀번호는 6자 이상으로 정해 주세요."); return; }
      withTimeout(sb.auth.updateUser({ password: pw }), 15000).then(function (r) {
        if (r.error) toast(explainAuthError(r.error)); else { document.getElementById("p-pass").value = ""; toast("비밀번호를 바꿨어요."); }
      }, function (e) { toast(explainAuthError(e)); });
    }
    else if (act === "join-choir") {
      var nm2 = b.getAttribute("data-name");
      write(sb.rpc("join_choir", { p_choir: id }), "‘" + nm2 + "’ 성가대로 이동했어요.", switchedChoir());
    }
    else if (act === "create-choir") {
      var cn = val("new-choir"); if (!cn) { toast("새 성가대 이름을 입력하세요."); return; }
      write(sb.rpc("create_choir", { p_name: cn }), "‘" + cn + "’ 성가대를 만들었어요. 상단의 ‘편집’에서 곡을 추가하세요.", switchedChoir());
    }
    else if (act === "leave-choir") {
      if (b.getAttribute("data-confirm") !== "1") { b.setAttribute("data-confirm", "1"); b.textContent = "정말 탈퇴"; return; }
      var left = choir.name;
      write(sb.rpc("leave_choir", { p_choir: choir.id }), "‘" + left + "’에서 탈퇴했어요.", switchedChoir());
    }
    else if (act === "remove-member") {
      if (b.getAttribute("data-confirm") !== "1") { b.setAttribute("data-confirm", "1"); b.textContent = "정말 내보내기"; return; }
      write(sb.rpc("remove_member", { p_choir: choir.id, p_user: id }), "대원을 내보냈어요.", function () { loadMembers(); });
    }
    else if (act === "metro") { var s = songById(id); if (metro.songId === id) metroStop(); else if (s) metroStart(s); }
    else if (act === "bpm") {
      var s2 = songById(id); if (!s2) return;
      if (metro.bpmFor !== id) { metro.bpm = tempoOf(s2); metro.bpmFor = id; }
      metro.bpm = Math.min(220, Math.max(30, metro.bpm + (+b.getAttribute("data-d"))));
      if (metro.songId === id) metroStart(s2); else syncMetroUI(id);
    }
    else if (act === "key") { var s3 = songById(id); if (s3) playKey(s3); }
    else if (act === "rate") {
      var pl = b.closest(".player"), au = pl && pl.querySelector("audio"); if (!au) return;
      au.playbackRate = +b.getAttribute("data-r");
      pl.querySelectorAll('[data-act="rate"]').forEach(function (x) { x.setAttribute("aria-pressed", x === b); });
    }
    else if (act === "ab") {
      var pl2 = b.closest(".player"), a2 = pl2 && pl2.querySelector("audio"), txt = pl2.querySelector(".abtxt"); if (!a2) return;
      if (!a2.dataset.a) { a2.dataset.a = a2.currentTime; b.textContent = "구간 끝(B)"; txt.textContent = "A " + fmtTime(a2.currentTime) + " →"; }
      else if (!a2.dataset.b) {
        if (a2.currentTime <= +a2.dataset.a + 0.5) { toast("A 지점보다 뒤에서 B를 지정하세요."); return; }
        a2.dataset.b = a2.currentTime; b.textContent = "반복 해제"; txt.textContent = "A " + fmtTime(+a2.dataset.a) + " → B " + fmtTime(+a2.dataset.b) + " 반복 중";
        a2.currentTime = +a2.dataset.a; a2.play();
      } else { delete a2.dataset.a; delete a2.dataset.b; b.textContent = "구간 시작(A)"; txt.textContent = ""; }
    }
    else if (act === "yt") {
      var box = b.parentNode, vid = b.getAttribute("data-vid");
      box.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(vid) + '?autoplay=1&playsinline=1&rel=0" title="연습 영상" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>';
    }
    else if (act === "install") { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt.userChoice.finally(function () { deferredPrompt = null; render(); }); } }
    else if (act === "install-x") { prefs.installDismissed = true; lsSet("choir.prefs", prefs); render(); }
    else if (act === "logout") {
      withTimeout(sb.auth.signOut(), 8000).catch(function () {}).then(function () { signedOut("로그아웃했어요."); });
    }
    else if (act === "admin") { ui.admin = !ui.admin; ui.editSong = null; go(ui.admin ? "admin" : "week"); }
    else if (act === "save-info") {
      var cname = val("f-choir"); if (!cname) { toast("성가대 이름을 입력하세요."); return; }
      write(sb.from("choirs").update({ name: cname, notice: val("f-notice"), updated_at: new Date().toISOString() }).eq("id", choir.id), "성가대 정보를 바꿨어요.");
    }
    else if (act === "add-svc") {
      var d = val("f-date"), slot = val("f-slot") || "낮예배", sid = val("f-song");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast("날짜를 선택하세요."); return; }
      if (!sid) { toast("먼저 곡을 추가하세요."); return; }
      write(sb.from("services").insert({ choir_id: choir.id, date: d, slot: slot, song_id: sid }), fmtShort(d) + " " + slot + " 선곡을 추가했어요.");
    }
    else if (act === "del-svc") {
      if (b.getAttribute("data-confirm") !== "1") { b.setAttribute("data-confirm", "1"); b.textContent = "정말 삭제"; return; }
      write(sb.from("services").delete().eq("id", id), "선곡을 삭제했어요.");
    }
    else if (act === "new-song") { ui.editSong = blankSong(); render(); var ft = document.getElementById("s-title"); if (ft) ft.focus(); }
    else if (act === "edit-song") {
      var es = songById(id); if (!es) return;
      ui.editSong = JSON.parse(JSON.stringify(es)); ui.view = "admin"; render();
      var fm = document.getElementById("songform"); if (fm) fm.scrollIntoView({ block: "start" });
    }
    else if (act === "cancel-song") { ui.editSong = null; render(); }
    else if (act === "apply-song") {
      var ns = readSongForm(ui.editSong);
      if (!ns.title) { toast("곡명을 입력하세요."); return; }
      var row = songRow(ns);
      var op = ns.id ? sb.from("songs").update(row).eq("id", ns.id) : sb.from("songs").insert(Object.assign({ choir_id: choir.id }, row));
      ui.editSong = null;
      write(op, "‘" + ns.title + "’ " + (ns.id ? "수정했어요." : "추가했어요."));
    }
    else if (act === "del-song") {
      if (b.getAttribute("data-confirm") !== "1") { b.setAttribute("data-confirm", "1"); b.textContent = "선곡까지 삭제"; return; }
      write(sb.from("songs").delete().eq("id", id), "곡과 그 곡의 선곡 기록을 삭제했어요.");
    }
  });
  app.addEventListener("change", function (e) {
    var t = e.target, act = t.getAttribute("data-act");
    if (act === "done") {
      var id = t.getAttribute("data-id");
      if (t.checked) prefs.done[id] = true; else delete prefs.done[id];
      lsSet("choir.prefs", prefs);
    } else if (act === "role") {
      var r = t.value, who = t.getAttribute("data-id");
      write(sb.rpc("set_member_role", { p_choir: choir.id, p_user: who, p_role: r }), ROLE_NAME[r] + (r === "member" ? "으로" : "로") + " 바꿨어요.", function () { loadMembers(); });
    }
  });
  app.addEventListener("submit", function (e) {
    var f = e.target; e.preventDefault();
    var btn = f.querySelector("button[type=submit]"), label = btn ? btn.textContent : "";
    function busy() { if (btn) { btn.disabled = true; btn.textContent = "처리 중…"; } }
    function reset(msg) { if (btn) { btn.disabled = false; btn.textContent = label; } if (msg) toast(msg); }
    var email = val("a-email"), passEl = document.getElementById("a-pass"), pass = passEl ? passEl.value : "";

    if (f.id === "loginform") {
      busy(); loginInFlight = true;
      withTimeout(sb.auth.signInWithPassword({ email: email, password: pass }), 20000).then(function (r) {
        loginInFlight = false;
        if (r.error) return reset(explainAuthError(r.error));
        session = r.data.session; ui.screen = "boot"; render(); loadAll();
      }, function (e) { loginInFlight = false; reset(explainAuthError(e)); });
    }
    else if (f.id === "signupform") {
      var name = val("a-name"), partEl = f.querySelector('input[name="a-part"]:checked'), part = partEl ? partEl.value : "all";
      if (!name) return reset("이름을 입력하세요.");
      if (pass.length < 6) return reset("비밀번호는 6자 이상으로 정해 주세요.");
      busy(); loginInFlight = true;
      withTimeout(sb.auth.signUp({ email: email, password: pass, options: { data: { display_name: name, part: part } } }), 20000).then(function (r) {
        loginInFlight = false;
        if (r.error) return reset(explainAuthError(r.error));
        if (!r.data.session) {   // 이메일 확인이 켜져 있는 경우
          ui.authTab = "login"; render();
          toast("가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요. (자동 승인하려면 Supabase에서 ‘Confirm email’을 끄세요)");
          return;
        }
        session = r.data.session; ui.screen = "boot"; render(); loadAll().then(function () { toast(name + "님, 가입을 환영합니다!"); });
      }, function (e) { loginInFlight = false; reset(explainAuthError(e)); });
    }
    else if (f.id === "forgotform") {
      busy();
      withTimeout(sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" }), 20000).then(function (r) {
        if (r.error) return reset(explainAuthError(r.error));
        reset("재설정 메일을 보냈어요. 메일의 링크를 이 기기에서 열어 주세요.");
      }, function (e) { reset(explainAuthError(e)); });
    }
    else if (f.id === "recoveryform") {
      if (pass.length < 6) return reset("비밀번호는 6자 이상으로 정해 주세요.");
      busy();
      withTimeout(sb.auth.updateUser({ password: pass }), 20000).then(function (r) {
        if (r.error) return reset(explainAuthError(r.error));
        history.replaceState(null, "", location.pathname);
        ui.screen = "boot"; render(); loadAll().then(function () { toast("비밀번호를 바꿨어요."); });
      }, function (e) { reset(explainAuthError(e)); });
    }
  });
  // A-B 구간 반복 (timeupdate는 버블링되지 않아 캡처 단계에서 받습니다)
  app.addEventListener("timeupdate", function (e) {
    var a = e.target; if (!a || a.tagName !== "AUDIO" || !a.dataset.b) return;
    if (a.currentTime >= +a.dataset.b) a.currentTime = +a.dataset.a;
  }, true);

  function signedOut(msg) {
    session = null; profile = null; choir = null; role = null; members = null; choirList = null;
    state = { songs: [], services: [] }; ui.admin = false; ui.view = "week"; ui.authTab = "login"; ui.screen = "auth";
    metroStop(); render(); if (msg) toast(msg);
  }

  /* ---------- boot ---------- */
  function boot() {
    if (!sb) {
      if (CFG.supabaseUrl) console.warn("Supabase 라이브러리를 불러오지 못했습니다.");
      ui.screen = "setup"; render(); return;
    }
    render();
    // Supabase 안내대로 이 콜백 안에서는 다른 Supabase 호출을 하지 않고, 다음 틱으로 미룹니다 (멈춤 방지).
    sb.auth.onAuthStateChange(function (evt, s) {
      if (evt === "INITIAL_SESSION") return;
      if (evt === "PASSWORD_RECOVERY") { session = s; setTimeout(function () { ui.screen = "recovery"; render(); }, 0); return; }
      if (evt === "SIGNED_OUT") { setTimeout(function () { if (ui.screen !== "auth") signedOut(); }, 0); return; }
      if (s) session = s;
      if (evt === "SIGNED_IN" && !loginInFlight && (ui.screen === "auth" || ui.screen === "boot")) setTimeout(loadAll, 0); // 다른 탭에서 로그인
    });
    withTimeout(sb.auth.getSession(), 10000).then(function (r) {
      session = r.data && r.data.session;
      if (ui.screen === "recovery") return;
      if (!session) { ui.screen = "auth"; render(); return; }
      var cached = lsGet(cacheKey(), null);
      if (cached && cached.choir) { applyChoirData(cached); ui.screen = "app"; render(); }   // 먼저 마지막 내용을 보여주고
      loadAll();                                                                           // 최신으로 바꿈
    }, function () { ui.screen = "auth"; render(); });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && ui.screen === "app" && !ui.admin && !ui.busy) reloadChoir().then(render).catch(function () {});
    });
  }
  boot();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
})();
