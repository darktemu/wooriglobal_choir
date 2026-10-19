/* 찬양대 연습노트 — 앱 본체 (빌드 과정 없이 그대로 배포) */
(function () {
  "use strict";

  var PARTS = [["all", "전체"], ["S", "소프라노"], ["A", "알토"], ["T", "테너"], ["B", "베이스"]];
  var LEVELS = ["하", "중하", "중", "중상", "상"];
  var DOW = ["일", "월", "화", "수", "목", "금", "토"];
  var CACHE_KEY = "choir.cache.v1";

  var app = document.getElementById("app");
  var CFG = window.CHOIR_CONFIG || {};
  var sb = null;
  if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  }

  /* ---------- storage helpers ---------- */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var state = { choirName: "찬양대", notice: "", songs: [], services: [] };
  var prefs = lsGet("choir.prefs", { part: "all", done: {}, installDismissed: false });
  if (!prefs.done) prefs.done = {};
  var ui = { view: "week", selDate: null, songId: null, q: "", pub: "", partTab: {}, admin: false, editSong: null, busy: false, offline: false };
  var auth = { session: null, editor: false };

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

  /* ---------- data loading ---------- */
  function applyData(d) {
    state.choirName = d.choirName || "찬양대";
    state.notice = d.notice || "";
    state.songs = (d.songs || []).map(function (s) { s.analysis = s.analysis || {}; s.parts = normParts(s.parts); return s; });
    state.services = d.services || [];
  }
  function fromDb(settings, songs, services) {
    return {
      choirName: settings && settings.choir_name,
      notice: settings && settings.notice,
      songs: (songs || []).map(function (r) { return { id: r.id, title: r.title, composer: r.composer, publisher: r.publisher, collection: r.collection, page: r.page, level: r.level, memo: r.memo, analysis: r.analysis, parts: r.parts }; }),
      services: (services || []).map(function (r) { return { id: r.id, date: r.date, slot: r.slot, songId: r.song_id }; })
    };
  }
  function load() {
    var p;
    if (sb) {
      p = Promise.all([
        sb.from("settings").select("*").eq("id", 1).maybeSingle(),
        sb.from("songs").select("*").order("title"),
        sb.from("services").select("*").order("date")
      ]).then(function (r) {
        for (var i = 0; i < r.length; i++) if (r[i].error) throw r[i].error;
        return fromDb(r[0].data, r[1].data, r[2].data);
      });
    } else {
      p = fetch("/data.json", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
    }
    return p.then(function (d) {
      applyData(d); ui.offline = false; lsSet(CACHE_KEY, d);
    }).catch(function () {
      var c = lsGet(CACHE_KEY, null);
      if (c) { applyData(c); ui.offline = true; }
      else throw new Error("load");
    });
  }

  /* ---------- auth ---------- */
  function refreshEditor() {
    if (!sb || !auth.session) { auth.editor = false; return Promise.resolve(); }
    return sb.rpc("is_editor").then(function (r) { auth.editor = !r.error && r.data === true; });
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
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    yt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/></svg>',
    src: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
  };

  /* ---------- render pieces ---------- */
  function levelPill(l) { return l ? '<span class="lv lv-' + esc(l) + '">난이도 ' + esc(l) + "</span>" : ""; }
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
    var tab = ui.partTab[song.id] || prefs.part || "all";
    var p = song.parts[tab];
    var h = '<div><p class="block-h">파트별 연습</p><div class="parts" role="tablist" aria-label="파트 선택">';
    PARTS.forEach(function (pp) {
      h += '<button class="pt p-' + pp[0] + '" role="tab" aria-selected="' + (tab === pp[0]) + '" data-act="part" data-id="' + esc(song.id) + '" data-part="' + pp[0] + '"' + (hasLinks(song.parts[pp[0]]) ? "" : ' title="링크 없음"') + ">"
        + (pp[0] !== "all" ? "<i></i>" : "") + pp[1] + (prefs.part === pp[0] && pp[0] !== "all" ? ' <span class="mine">내 파트</span>' : "") + "</button>";
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
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredPrompt = e; if (ui.view === "week") render(); });
  function installBanner() {
    if (isStandalone || prefs.installDismissed || (!deferredPrompt && !isIOS)) return "";
    var msg = deferredPrompt ? "<b>홈 화면에 설치</b>하면 앱처럼 바로 열 수 있어요."
      : "Safari 아래쪽 <b>공유 버튼 → 홈 화면에 추가</b>를 누르면 앱처럼 쓸 수 있어요.";
    return '<div class="install"><p>' + msg + "</p>" + (deferredPrompt ? '<button class="btn primary mini" data-act="install">설치</button>' : "") + '<button class="btn mini" data-act="install-x" aria-label="안내 닫기">닫기</button></div>';
  }

  /* ---------- views ---------- */
  function viewWeek() {
    var ds = dates(), nd = nextDate();
    if (!ui.selDate || ds.indexOf(ui.selDate) < 0) ui.selDate = nd;
    var h = installBanner();
    if (state.notice) h += '<div class="notice"><b>공지</b><span>' + esc(state.notice) + "</span></div>";
    if (nd) {
      var svcs = servicesSorted().filter(function (s) { return s.date === nd; });
      var dd = daysUntil(nd), when = dd === 0 ? "오늘" : dd > 0 ? dd + "일 남음" : "지난 예배";
      var titles = svcs.map(function (s) { var so = songById(s.songId); return so ? so.title : ""; }).filter(Boolean);
      h += '<section class="hero" aria-label="다음 예배"><div class="eyebrow">다음 찬양 · ' + when + "</div><h1>" + esc(titles.join(" / ") || "선곡 준비 중") + '</h1><p class="when">' + fmtLong(nd) + " · " + esc(svcs.map(function (s) { return s.slot; }).join(", ")) + '</p><p class="count">' + esc(state.choirName) + "</p></section>";
    }
    h += '<section style="display:flex;flex-direction:column;gap:12px"><div class="sec-title"><h2>예배별 선곡</h2><p>날짜를 눌러 그날 부를 곡을 확인하세요</p></div><div class="strip" id="strip">';
    var t = today();
    ds.forEach(function (d) {
      var svcs = state.services.filter(function (s) { return s.date === d; });
      var sub = svcs.length > 1 ? svcs.length + "회 예배" : (svcs[0] ? svcs[0].slot : "");
      h += '<button class="chip' + (d < t ? " past" : "") + (d === nd ? " next" : "") + '" data-act="date" data-date="' + d + '" aria-pressed="' + (d === ui.selDate) + '"><b>' + fmtShort(d) + "</b><span>" + (d === nd ? "다음 · " : "") + esc(sub) + "</span></button>";
    });
    h += "</div></section>";
    if (ui.selDate) {
      h += '<section style="display:flex;flex-direction:column;gap:14px"><div class="sec-title"><h2>' + fmtLong(ui.selDate) + "</h2></div>";
      servicesSorted().filter(function (s) { return s.date === ui.selDate; }).forEach(function (s) { var so = songById(s.songId); if (so) h += songCard(so, s); });
      h += "</section>";
    } else h += '<p class="empty">등록된 예배 일정이 없습니다.' + (auth.editor ? " 편집에서 첫 선곡을 추가하세요." : "") + "</p>";
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
    if (!rows.length) return '<li><p class="empty" style="padding:12px 16px;margin:0">조건에 맞는 곡이 없습니다.</p></li>';
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
    var h = '<div class="sec-title"><h2>내 연습</h2><p>이 기기에만 저장됩니다</p></div>';
    h += '<section class="panel"><p class="block-h" style="margin:0">내 파트</p><div class="mypart">';
    [["S", "소프라노", "S"], ["A", "알토", "A"], ["T", "테너", "T"], ["B", "베이스", "B"], ["all", "전체", "♫"]].forEach(function (p) {
      h += '<button data-act="mypart" data-part="' + p[0] + '" aria-pressed="' + (prefs.part === p[0]) + '"><b>' + p[2] + "</b>" + p[1] + "</button>";
    });
    h += '</div><p class="empty" style="margin:0">고른 파트가 모든 곡의 연습 탭에서 먼저 열립니다.</p></section>';
    h += '<section class="panel"><div class="sec-title"><p class="block-h" style="margin:0">다가오는 곡 준비도</p><p><span class="pnum">' + done + " / " + ids.length + '</span>곡</p></div><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>';
    if (ids.length) {
      h += '<ul class="list" style="border-radius:10px">';
      upcoming.forEach(function (v) {
        var s = songById(v.songId); if (!s) return;
        h += '<li><button class="row" data-act="song" data-id="' + esc(s.id) + '"><span class="t"><b>' + esc(s.title) + "</b><span>" + fmtShort(v.date) + " " + esc(v.slot) + "</span></span>" + (prefs.done[s.id] ? '<span class="ok-mark">완료</span>' : '<span class="empty" style="margin:0;font-size:12px">연습 전</span>') + "</button></li>";
      });
      h += "</ul>";
    } else h += '<p class="empty" style="margin:0">예정된 예배가 없습니다.</p>';
    h += "</section>";
    h += loginPanel();
    return h;
  }
  function loginPanel() {
    var h = '<section class="panel login"><p class="block-h" style="margin:0">지휘자·임원 로그인</p>';
    if (!sb) return h + '<p class="empty" style="margin:0">지금은 예시 데이터를 보여주는 읽기 전용 모드입니다. config.js에 Supabase를 연결하면 로그인과 편집이 켜집니다.</p></section>';
    if (auth.session) {
      var email = auth.session.user && auth.session.user.email;
      h += '<p style="margin:0">' + esc(email) + " 계정으로 로그인했습니다. " + (auth.editor ? "편집 권한이 있습니다." : "<b>편집 권한이 없는 계정</b>입니다. 관리자에게 편집자 등록을 요청하세요.") + "</p>";
      return h + '<div class="btns" style="justify-content:flex-start">' + (auth.editor ? '<button class="btn primary" data-act="admin">편집 열기</button>' : "") + '<button class="btn" data-act="logout">로그아웃</button></div></section>';
    }
    return h + '<form id="loginform" class="login"><div class="row2"><input id="l-email" type="email" autocomplete="username" placeholder="이메일" required><input id="l-pass" type="password" autocomplete="current-password" placeholder="비밀번호" required></div><div class="btns" style="justify-content:flex-start"><button class="btn primary" type="submit">로그인</button></div><p class="empty" style="margin:0">대원은 로그인하지 않아도 모든 내용을 볼 수 있습니다.</p></form></section>';
  }

  function viewAdmin() {
    var h = '<div class="sec-title"><h2>편집</h2><p>적용하면 바로 모든 대원에게 반영됩니다</p></div>';
    h += '<section class="panel"><p class="block-h" style="margin:0">찬양대 정보</p><div class="form"><label class="full">찬양대 이름<input id="f-choir" value="' + esc(state.choirName) + '"></label><label class="full">공지 (비우면 숨김)<textarea id="f-notice">' + esc(state.notice) + '</textarea></label></div><div class="btns"><button class="btn primary" data-act="save-info">적용</button></div></section>';
    var sorted = state.songs.slice().sort(function (a, b) { return a.title.localeCompare(b.title, "ko"); });
    h += '<section class="panel"><p class="block-h" style="margin:0">예배 선곡 추가</p><div class="form">'
      + '<label>날짜<input id="f-date" type="date" value="' + esc(nextSunday()) + '"></label>'
      + '<label>예배<input id="f-slot" list="slots" value="낮예배"><datalist id="slots"><option value="낮예배"><option value="저녁예배"><option value="새벽예배"><option value="특별예배"></datalist></label>'
      + '<label class="full">곡<select id="f-song">' + sorted.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.title) + (s.composer ? " — " + esc(s.composer) : "") + "</option>"; }).join("") + "</select></label>"
      + '</div><div class="btns"><button class="btn primary" data-act="add-svc">선곡 추가</button></div>';
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
    if (ui.view === "admin" && !(ui.admin && auth.editor)) { ui.admin = false; ui.view = "week"; }
    var tabs = [["week", "이번 주", ICON.week], ["songs", "곡 목록", ICON.list], ["me", "내 연습", ICON.me]];
    var cur = ui.view === "song" ? "songs" : ui.view;
    var h = '<header class="top"><div class="wrap"><div class="brand"><small>성가대 연습실</small><b>' + esc(state.choirName) + "</b></div>";
    h += '<nav class="tabs" aria-label="주요 화면">' + tabs.map(function (t) { return '<button class="tab" data-act="tab" data-view="' + t[0] + '"' + (cur === t[0] ? ' aria-current="page"' : "") + ">" + t[2] + "<span>" + t[1] + "</span></button>"; }).join("") + "</nav>";
    if (auth.editor) h += '<button class="editbtn" data-act="admin" aria-pressed="' + ui.admin + '">' + (ui.admin ? "편집 닫기" : "편집") + "</button>";
    h += '</div></header><main class="wrap">';
    if (ui.offline) h += '<div class="notice"><b>오프라인</b><span>마지막으로 받아 둔 내용을 보여주고 있습니다.</span></div>';
    if (ui.admin && ui.view !== "admin") h += '<div class="btns" style="justify-content:flex-start"><button class="btn mini" data-act="tab" data-view="admin">선곡·곡 관리로 이동</button></div>';
    h += ({ week: viewWeek, songs: viewSongs, song: viewSong, me: viewMe, admin: viewAdmin }[ui.view] || viewWeek)();
    h += '<p class="foot">파트 연습 음원·영상·악보의 저작권은 각 출판사에 있습니다. 이 앱은 연습 편의를 위한 링크만 모아 둡니다.</p></main>';
    var old = document.getElementById("strip"), sx = old ? old.scrollLeft : null;
    app.innerHTML = h;
    var strip = document.getElementById("strip");
    if (strip) {
      if (sx != null) strip.scrollLeft = sx;
      else { var sel = strip.querySelector('[aria-pressed="true"]'); if (sel) strip.scrollLeft = Math.max(0, sel.offsetLeft - strip.offsetLeft - 40); }
    }
    var q = document.getElementById("q");
    if (q) q.addEventListener("input", function () { ui.q = q.value; document.getElementById("songlist").innerHTML = songRows(); });
  }
  function go(view) { ui.view = view; render(); window.scrollTo(0, 0); }
  var toastTimer = null;
  function toast(msg) {
    var t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  }

  /* ---------- writes (Supabase) ---------- */
  function write(promise, okMsg) {
    if (ui.busy) return Promise.resolve();
    ui.busy = true;
    return promise.then(function (r) {
      if (r && r.error) throw r.error;
      return load();
    }).then(function () {
      ui.busy = false; render(); if (okMsg) toast(okMsg);
    }).catch(function (e) {
      ui.busy = false;
      var m = (e && e.message) || "";
      if (/row-level security|permission|401|403|JWT/i.test(m)) toast("편집 권한이 없어 저장하지 못했어요. 다시 로그인해 보세요.");
      else if (!navigator.onLine) toast("인터넷 연결이 없어 저장하지 못했어요.");
      else toast("저장하지 못했어요. 잠시 후 다시 시도하세요.");
      render();
    });
  }
  function songRow(s) { return { title: s.title, composer: s.composer, publisher: s.publisher, collection: s.collection, page: s.page, level: s.level, memo: s.memo, analysis: s.analysis, parts: s.parts, updated_at: new Date().toISOString() }; }

  /* ---------- events ---------- */
  app.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    if (act === "done") return;
    if (act === "tab") go(b.getAttribute("data-view"));
    else if (act === "date") { ui.selDate = b.getAttribute("data-date"); render(); }
    else if (act === "song") { ui.songId = id; go("song"); }
    else if (act === "part") { ui.partTab[id] = b.getAttribute("data-part"); render(); }
    else if (act === "pub") { ui.pub = b.getAttribute("data-pub"); render(); }
    else if (act === "mypart") { prefs.part = b.getAttribute("data-part"); ui.partTab = {}; lsSet("choir.prefs", prefs); render(); }
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
    else if (act === "logout") { sb.auth.signOut(); }
    else if (act === "admin") { ui.admin = !ui.admin; ui.editSong = null; go(ui.admin ? "admin" : "week"); }
    else if (act === "save-info") {
      write(sb.from("settings").upsert({ id: 1, choir_name: val("f-choir") || state.choirName, notice: val("f-notice"), updated_at: new Date().toISOString() }), "찬양대 정보를 바꿨어요.");
    }
    else if (act === "add-svc") {
      var d = val("f-date"), slot = val("f-slot") || "낮예배", sid = val("f-song");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast("날짜를 선택하세요."); return; }
      if (!sid) { toast("먼저 곡을 추가하세요."); return; }
      write(sb.from("services").insert({ date: d, slot: slot, song_id: sid }), fmtShort(d) + " " + slot + " 선곡을 추가했어요.");
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
      var op = ns.id ? sb.from("songs").update(songRow(ns)).eq("id", ns.id) : sb.from("songs").insert(songRow(ns));
      ui.editSong = null;
      write(op, "‘" + ns.title + "’ " + (ns.id ? "수정했어요." : "추가했어요."));
    }
    else if (act === "del-song") {
      if (b.getAttribute("data-confirm") !== "1") { b.setAttribute("data-confirm", "1"); b.textContent = "선곡까지 삭제"; return; }
      write(sb.from("songs").delete().eq("id", id), "곡과 그 곡의 선곡 기록을 삭제했어요.");
    }
  });
  app.addEventListener("change", function (e) {
    var t = e.target; if (t.getAttribute("data-act") !== "done") return;
    var id = t.getAttribute("data-id");
    if (t.checked) prefs.done[id] = true; else delete prefs.done[id];
    lsSet("choir.prefs", prefs);
  });
  app.addEventListener("submit", function (e) {
    if (e.target.id !== "loginform") return;
    e.preventDefault();
    var btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "로그인 중…";
    sb.auth.signInWithPassword({ email: val("l-email"), password: document.getElementById("l-pass").value }).then(function (r) {
      if (r.error) { btn.disabled = false; btn.textContent = "로그인"; toast("이메일 또는 비밀번호가 맞지 않아요."); }
    });
  });
  // A-B 구간 반복 (timeupdate는 버블링되지 않아 캡처 단계에서 받습니다)
  app.addEventListener("timeupdate", function (e) {
    var a = e.target; if (!a || a.tagName !== "AUDIO" || !a.dataset.b) return;
    if (a.currentTime >= +a.dataset.b) a.currentTime = +a.dataset.a;
  }, true);

  /* ---------- boot ---------- */
  function boot() {
    var cached = lsGet(CACHE_KEY, null);
    if (cached) { applyData(cached); render(); }
    var authReady = Promise.resolve();
    if (sb) {
      authReady = sb.auth.getSession().then(function (r) { auth.session = r.data && r.data.session; return refreshEditor(); });
      sb.auth.onAuthStateChange(function (evt, session) {
        if (evt === "INITIAL_SESSION") return;
        auth.session = session;
        refreshEditor().then(function () {
          if (evt === "SIGNED_IN") toast(auth.editor ? "로그인했어요. 상단의 ‘편집’에서 관리할 수 있어요." : "로그인했지만 편집 권한이 없는 계정이에요.");
          if (evt === "SIGNED_OUT") { ui.admin = false; toast("로그아웃했어요."); }
          render();
        });
      });
    } else if (CFG.supabaseUrl) {
      console.warn("Supabase 라이브러리를 불러오지 못해 읽기 전용으로 동작합니다.");
    }
    Promise.all([load(), authReady.catch(function () {})]).then(render).catch(function () {
      app.innerHTML = '<div class="wrap boot">찬양 목록을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 열어 주세요.</div>';
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !ui.admin && !ui.busy) load().then(render).catch(function () {});
    });
  }
  boot();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
})();
