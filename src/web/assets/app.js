/* 승리 효과음 — 외부 음원 파일 없이 Web Audio로 합성한 짧고 조용한 2음 차임.
   브라우저 자동재생 정책 때문에 첫 사용자 조작 시점에 오디오 컨텍스트를 미리 열어두고(unlock),
   이후 타이머로 공개되는 결과(사다리 등)에서도 소리가 나도록 한다. 실패하면 조용히 무시. */
(function(){
  var ctx = null;
  function ac(){
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch(e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch(e){} }
    return ctx;
  }
  function tone(c, freq, at, dur, peak, type){
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(c.destination);
    o.start(at); o.stop(at + dur + 0.02);
  }
  // 짧은 노이즈 버스트를 저역 필터로 눌러 "퍽" 하는 가벼운 폭발음을 만든다 (시끄럽지 않게 짧게 감쇠)
  function boomAt(c, at, level, pitch){
    var dur = 0.32;
    var buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    }
    var src = c.createBufferSource(); src.buffer = buf;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 * (pitch || 1), at);
    lp.frequency.exponentialRampToValueAtTime(140, at + dur);
    var g = c.createGain();
    g.gain.setValueAtTime(Math.max(0.005, level), at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(lp); lp.connect(g); g.connect(c.destination);
    src.start(at); src.stop(at + dur);
  }
  // 실제 녹음 샘플 (Kenney Casino Audio, CC0). 합성음보다 훨씬 자연스러워서 이쪽을 우선 쓰고,
  // 로딩 실패하거나 아직 안 받아졌으면 아래 합성음으로 대체한다.
  var sfxBuf = {};
  var SFX_EXT = { 'coin-insert':'wav', 'card-shuffle':'wav', 'win-fanfare':'wav',
                  'card-flip':'mp3', 'card-deal':'mp3',
                  'coin-gain':'mp3', 'mine-coin':'mp3', 'explode':'mp3' };
  // 원본이 길어서 그대로 쓰면 연달아 울릴 때 겹쳐 뭉개지는 음원은 최대 길이를 정해 잘라 쓴다
  var SFX_MAX = { 'explode': 0.4, 'mine-coin': 0.6, 'card-flip': 0.5, 'card-deal': 0.35 };

  // 음원 앞뒤의 무음을 잘라낸다.
  // 앞 무음이 남아 있으면 눌러도 소리가 그만큼 늦게 나서 반응이 굼떠 보이고,
  // 뒤 무음은 동시 재생 수만 잡아먹는다. 끝은 짧게 페이드해 뚝 끊기는 소리를 막는다.
  function trimSilence(c, buf, maxSec){
    var ch = buf.numberOfChannels, len = buf.length, k, i;
    var peak = 0;
    for (k = 0; k < ch; k++) {
      var d = buf.getChannelData(k);
      for (i = 0; i < len; i++) { var v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
    }
    if (!peak) return buf;
    var thr = peak * 0.02, start = len, end = 0;
    for (k = 0; k < ch; k++) {
      var s = buf.getChannelData(k);
      for (i = 0; i < len; i++) { if ((s[i] < 0 ? -s[i] : s[i]) > thr) { if (i < start) start = i; break; } }
      for (i = len - 1; i >= 0; i--) { if ((s[i] < 0 ? -s[i] : s[i]) > thr) { if (i > end) end = i; break; } }
    }
    if (start >= end) return buf;
    var sr = buf.sampleRate;
    start = Math.max(0, start - Math.round(sr * 0.005));   // 시작 직전 아주 살짝 여유
    end = Math.min(len - 1, end + Math.round(sr * 0.04));  // 여운은 조금 남긴다
    // 길이 상한이 있으면 앞부분만 남기고 잘라낸다 (연달아 재생될 소리는 짧아야 겹쳐도 안 뭉개진다)
    if (maxSec) end = Math.min(end, start + Math.round(sr * maxSec) - 1);
    var n = end - start + 1;
    if (n >= len && !maxSec) return buf;

    var out = c.createBuffer(ch, n, sr);
    // 상한 때문에 중간을 잘랐으면 페이드를 길게 줘 뚝 끊기지 않게 한다
    var fade = Math.min(Math.round(sr * (maxSec ? 0.08 : 0.02)), n);
    for (k = 0; k < ch; k++) {
      var o = out.getChannelData(k);
      o.set(buf.getChannelData(k).subarray(start, end + 1));
      for (i = 0; i < fade; i++) o[n - fade + i] *= 1 - i / fade;
    }
    return out;
  }

  function loadSfx(name){
    if (sfxBuf[name] !== undefined) return;
    var c = ac(); if (!c) return;
    sfxBuf[name] = null; // 로딩 중
    fetch('/sfx/' + name + '.' + (SFX_EXT[name] || 'ogg') + '?v=__ASSET_V__')
      .then(function(r){ return r.ok ? r.arrayBuffer() : Promise.reject(); })
      .then(function(b){ return c.decodeAudioData(b); })
      .then(function(buf){ sfxBuf[name] = trimSilence(c, buf, SFX_MAX[name]); })
      .catch(function(){ sfxBuf[name] = false; });
  }
  // 칩을 올리는 동작은 단위와 상관없이 같은 "동전 넣는" 소리로 통일한다.
  // (소리가 두 종류로 갈리면 같은 동작인데 다른 효과음처럼 들린다)
  var SFX_SETS = {
    coin: ['coin-insert'],      // 칩 올리기
    gain: ['coin-gain'],        // 포커 회수 · 지뢰찾기 캐시아웃
    fanfare: ['win-fanfare'],   // 그래프·사다리 승리 (게임마다 승리음이 다르다)
    minecoin: ['mine-coin'],
    explode: ['explode'],
    shuffle: ['card-shuffle'],  // 새 라운드 셔플
    deal: ['card-deal'],        // 카드 한 장 배분
    card: ['card-flip'],        // 보드 카드 공개
  };
  // 페이지가 쓰지도 않는 음원까지 받으면 WAV가 커서 낭비가 크다.
  // 각 페이지가 window.__SFX_NEED__ 로 필요한 종류만 선언한다.
  // 선언이 없으면 아무것도 받지 않는다 — 예전에는 없으면 "전부"였고, 그 탓에 소리를 쓰지 않는
  // 로비·랭킹·로그인 화면에서도 효과음 8종(1.1MB, wav 3개 포함)을 내려받아 디코딩했다.
  // 페이지 로드 400ms 뒤에 그게 시작돼 메인 스레드가 붙들리고 hover가 멈춘 채 렉이 걸렸다.
  function preloadSfx(){
    var need = window.__SFX_NEED__;
    if (!need || !need.length) return;
    need.forEach(function(k){ (SFX_SETS[k] || []).forEach(loadSfx); });
  }
  // 같은 소리만 반복되면 기계적으로 들려서 변형 중 하나를 무작위로 고른다.
  // 칩을 연타하면 1초 넘는 소리가 겹겹이 쌓여 지저분해지므로, 종류별로 동시에 울리는
  // 개수를 제한하고 넘치면 가장 오래된 것부터 끊는다.
  // 지뢰 연쇄 폭발은 90ms 간격으로 최대 5번 울리므로 그만큼 동시 재생을 허용한다
  var VOICES = { explode: 5 };
  var DEFAULT_VOICES = 3;
  var playing = {};
  function playSample(set, gain){
    var c = ac(); if (!c) return false;
    var names = SFX_SETS[set] || [];
    var ready = names.filter(function(n){ return sfxBuf[n]; });
    if (!ready.length) { names.forEach(loadSfx); return false; }

    var cap = VOICES[set] || DEFAULT_VOICES;
    var live = playing[set] = (playing[set] || []).filter(function(s){ return !s.__done; });
    while (live.length >= cap) {
      var old = live.shift();
      try { old.stop(); } catch(e){}
    }

    var buf = sfxBuf[ready[Math.floor(Math.random() * ready.length)]];
    var src = c.createBufferSource(); src.buffer = buf;
    var g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(c.destination);
    src.onended = function(){ src.__done = true; };
    src.start();
    live.push(src);
    return true;
  }

  // 아주 짧은 고역 노이즈 — 금속끼리 부딪히는 "짤랑"의 알갱이 부분
  function clinkAt(c, at, level){
    var dur = 0.09;
    var buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 5);
    }
    var src = c.createBufferSource(); src.buffer = buf;
    var hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
    var g = c.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(hp); hp.connect(g); g.connect(c.destination);
    src.start(at); src.stop(at + dur);
  }
  window.casinoSfx = {
    // 적중/캐시아웃 — 게임마다 승리음이 다르다.
    // kind: 'fanfare'(그래프·사다리) | 그 외(포커·지뢰찾기의 코인 회수음)
    win: function(kind){
      if (playSample(kind === 'fanfare' ? 'fanfare' : 'gain', 0.6)) return;
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      var notes = [1046.5, 1318.5, 1568.0, 2093.0]; // C6 E6 G6 C7
      notes.forEach(function(f, i){
        tone(c, f, t + i*0.055, 0.16, 0.075 - i*0.008, 'triangle');
      });
      tone(c, 2637.0, t + 0.24, 0.30, 0.035, 'sine'); // 끝에 살짝 남는 반짝임(E7)
    },
    // 안전 칸 오픈 — 아주 짧고 가벼운 "톡"
    // 안전 칸 오픈 — 금화 획득 소리. 없으면 짧고 가벼운 "톡"
    safe: function(){
      if (playSample('minecoin', 0.55)) return;
      var c = ac(); if (!c) return;
      tone(c, 1046.5, c.currentTime, 0.075, 0.05, 'triangle'); // C6
    },
    // 낙첨 — 조용히 내려가는 2음 (승리음과 반대 방향)
    lose: function(){
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      tone(c, 392.0, t, 0.14, 0.055, 'triangle');        // G4
      tone(c, 293.7, t + 0.09, 0.24, 0.045, 'triangle'); // D4
    },
    // 지뢰 — 가벼운 폭발음 (level/pitch로 연쇄 폭발의 잔향 표현)
    // 지뢰 — 실제 폭발음(앞 0.55초만 잘라 씀). 연쇄 폭발은 level로 점점 작게 울린다.
    boom: function(level, pitch){
      var g = level == null ? 0.16 : level;
      if (playSample('explode', Math.min(1, g * 3.2))) return;
      var c = ac(); if (!c) return;
      boomAt(c, c.currentTime, g, pitch);
    },
    // 칩 올리기 — 동전 넣는 소리 (동전·골드바 공통)
    chip: function(){
      if (playSample('coin', 0.6)) return;
      var c = ac(); if (!c) return;   // 샘플이 아직 안 받아졌을 때만 쓰는 대체음
      var t = c.currentTime;
      clinkAt(c, t, 0.05);
      tone(c, 3136.0, t + 0.005, 0.10, 0.030, 'triangle'); // G7
      tone(c, 4186.0, t + 0.020, 0.08, 0.019, 'triangle'); // C8
      tone(c, 2349.0, t + 0.034, 0.13, 0.015, 'sine');     // D7 — 살짝 남는 여운
    },
    // 카드 공개 — 뒤집는 소리
    card: function(){
      if (playSample('card', 0.5)) return;
      var c = ac(); if (!c) return;
      clinkAt(c, c.currentTime, 0.028);
    },
    // 새 라운드 시작 — 카드 섞는 소리
    shuffle: function(){ playSample('shuffle', 0.5); },
    // 카드를 한 장 나눠줄 때
    deal: function(){ playSample('deal', 0.55); }
  };
  /* ── 상태 폴링 공용 헬퍼 ─────────────────────────────────────────────
     세 게임의 poll()이 공유한다. 원래는 각 게임이 fetch를 그대로 await 했는데,
     서버가 잠깐 끊기면(배포 중 머신 재시작 등) fetch가 거부되고 그 거부가 처리되지 않아
     render()까지 도달하지 못했다. 그러면 SSR 골격만 남고 카드·베팅판·칩 버튼이 영구히
     비어 있는 상태로 굳는다 — 화면은 죽었는데 아무 안내도 없다.
     타임아웃도 없어서 응답 없는 요청이 1초마다 계속 쌓였다.
     실패는 null로 돌려주고, 호출한 쪽이 안내를 띄우고 다음 주기에 다시 시도한다. */
  window.casinoPoll = function(url, timeoutMs){
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function(){ if (ctl) ctl.abort(); }, timeoutMs || 8000);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined)
      .then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(){ return null; })
      .then(function(v){ clearTimeout(t); return v; });
  };

  // 오디오 컨텍스트는 사용자 조작이 있어야 재생이 풀리므로 첫 클릭에서 깨운다.
  document.addEventListener('pointerdown', function(){ ac(); preloadSfx(); }, { once: true });
  // 미리 받아두는 작업은 브라우저가 한가할 때로 미룬다 — 첫 화면이 그려지고 스크롤·hover가
  // 부드럽게 도는 게 효과음 준비보다 우선이다. requestIdleCallback이 없으면 타이머로 대체.
  window.addEventListener('load', function(){
    var run = function(){ preloadSfx(); };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 1200);
  });
})();

/* ── 진입 구간 계측 ────────────────────────────────────────────────────
   "화면이 3~5초 멈춘 뒤 내용이 뜬다"는 현상을 재현하지 못해(측정 환경에서는 160ms),
   실제 사용 브라우저에서 어느 구간이 느린지 콘솔에 남긴다.
   navigationStart 기준 경과 시간이므로 페이지를 열자마자의 시간축과 일치한다. */
(function(){
  window.__casinoMarks = [];
  window.casinoMark = function(label){
    var ms = Math.round(performance.now());
    window.__casinoMarks.push(label + ' ' + ms + 'ms');
    console.log('[카지노] ' + label + ' — ' + ms + 'ms');
  };
  // 메인 스레드가 오래 붙들리면 남긴다 (긴 작업 = 화면이 멈추는 원인).
  // longtask는 "얼마나 막혔는지"만 알려주고 누가 막았는지는 알려주지 않는다.
  // long-animation-frame은 그 프레임에서 실행된 스크립트의 URL·함수명까지 주므로,
  // 멈춤의 원인이 우리 코드인지 브라우저 확장인지 구분할 수 있다.
  try {
    new PerformanceObserver(function(list){
      list.getEntries().forEach(function(e){
        if (e.duration < 120) return;
        console.warn('[카지노] 메인 스레드 ' + Math.round(e.duration) + 'ms 붙듦 @ '
          + Math.round(e.startTime) + 'ms — 이 구간에 화면이 멈춘다');
        (e.scripts || []).forEach(function(s){
          console.warn('         └ ' + Math.round(s.duration) + 'ms  ' + (s.invoker || s.invokerType || '?')
            + '  ←  ' + (s.sourceURL || '(출처 불명 = 대개 브라우저 확장)')
            + (s.sourceFunctionName ? '  ' + s.sourceFunctionName + '()' : ''));
        });
      });
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function(list){
      list.getEntries().forEach(function(e){
        if (e.duration >= 120) {
          console.warn('[카지노] (longtask) ' + Math.round(e.duration) + 'ms @ ' + Math.round(e.startTime) + 'ms');
        }
      });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  window.addEventListener('load', function(){
    window.casinoMark('load 완료');
  });
  window.casinoMark('app.js 실행 완료');
})();
