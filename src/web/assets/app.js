/* 승리 효과음 — 외부 음원 파일 없이 Web Audio로 합성한 짧고 조용한 2음 차임.
   브라우저 자동재생 정책 때문에 첫 사용자 조작 시점에 오디오 컨텍스트를 미리 열어두고(unlock),
   이후 타이머로 공개되는 결과(사다리 등)에서도 소리가 나도록 한다. 실패하면 조용히 무시. */
(function(){
  var ctx = null;
  // 브라우저는 사용자 조작 전에는 오디오 재생을 허용하지 않는다. 그 전에 resume()을 부르면
  // 재생이 풀리지도 않으면서 "The AudioContext was not allowed to start" 경고만 콘솔에 쌓인다
  // (효과음 5개를 미리 받는 과정에서 실제로 35개가 찍혔다).
  // 디코딩은 suspended 상태에서도 되므로, resume은 첫 조작이 있었을 때만 시도한다.
  var gestureSeen = false;

  /* ── 효과음 켜기/끄기 ────────────────────────────────────────────────
     설정은 브라우저에 남겨 새로고침·페이지 이동에도 유지한다(서버에 저장할 이유가 없다 —
     같은 사람이라도 회사 PC에서는 끄고 집에서는 켜고 싶을 수 있다).
     이 파일은 <head>에서 동기 실행되므로 <html>에 상태 클래스를 미리 박아 둔다.
     그래야 헤더가 그려지는 첫 순간부터 아이콘이 올바른 모양으로 나온다(깜빡임 방지). */
  var SFX_KEY = 'od_sfx';
  var sfxOn = true;
  try { sfxOn = localStorage.getItem(SFX_KEY) !== 'off'; } catch(e){}
  function markSfxState(){
    var r = document.documentElement;
    if (r) r.classList.toggle('sfx-off', !sfxOn);
  }
  markSfxState();

  function ac(){
    // 꺼져 있으면 아예 컨텍스트를 열지 않는다.
    // 소리를 내는 모든 경로가 ac()의 null을 확인하고 빠져나가므로, 여기 한 곳만 막으면 된다
    // (합성음 대체 경로까지 포함해서).
    if (!sfxOn) return null;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch(e) { return null; }
    }
    if (gestureSeen && ctx.state === 'suspended') { try { ctx.resume(); } catch(e){} }
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
                  'coin-gain':'mp3', 'mine-coin':'mp3', 'explode':'mp3',
                  'chip-bet':'mp3', 'chip-bet2':'mp3', 'chips-to-winner':'mp3',
                  'tournament-win':'mp3' };
  // 원본이 길어서 그대로 쓰면 연달아 울릴 때 겹쳐 뭉개지는 음원은 최대 길이를 정해 잘라 쓴다
  var SFX_MAX = { 'explode': 0.4, 'mine-coin': 0.6, 'card-flip': 0.5, 'card-deal': 0.35 };
  // 파일마다 녹음 레벨이 제각각이다. 브라우저에서 실측하니 체감 음량(RMS) 편차가 29.4dB로,
  // 폭발음이 지뢰 금화음보다 8배 가까이 크게 들렸다(6dB = 체감 2배).
  // 아래는 각 파일을 같은 체감 음량(RMS -32dB)에 맞추되 피크가 -3dB를 넘지 않도록 제한해 구한 보정값이다.
  // 적용 후 편차 6.5dB. 재생 시 넘기는 gain은 "상대적 강조"만 담당한다(기본 1).
  // 효과음 파일을 교체하면 이 표도 다시 재야 한다.
  //
  // 새로 넣은 홀덤 칩 음원 셋은 브라우저에서 직접 재서 같은 기준선에 맞췄다.
  // 기존 8개의 "보정 후 실효 RMS"는 -27.4 ~ -32.0dB이고 평균 -29.9dB이다.
  // 실측: chip-bet RMS -17.4dB / chip-bet2 -17.1dB / chips-to-winner -28.7dB
  //       (앞의 둘은 피크 0dB로 아주 뜨겁게 녹음돼 있어 보정 없이 쓰면 다른 소리를 다 눌러버린다)
  // 그 평균에 맞춘 값이 아래 세 항목이다. 실효 RMS는 셋 다 -29.8 ~ -29.9dB.
  var SFX_NORM = {
    'coin-insert': 0.78, 'coin-gain': 0.71, 'card-flip': 0.71, 'card-shuffle': 0.94,
    'card-deal': 1.04, 'win-fanfare': 0.28, 'mine-coin': 2.6, 'explode': 0.16,
    'chip-bet': 0.24, 'chip-bet2': 0.23, 'chips-to-winner': 0.87,
    /* 우승 음악. 실측 RMS -11.2dB · 피크 +0.3dB(원본이 클리핑돼 있다)로 전체 중 가장 크다.
       기존 평균(-29.8dB)에 맞추면 0.117인데, 4.14초짜리 "음악"이라 짧은 효과음과 같은
       RMS로 맞춰도 지속음이어서 훨씬 크게 느껴진다. 그래서 2dB 더 낮춰 0.09로 둔다
       (실효 -32.1dB — 가장 조용한 mine-coin과 같은 수준).
       축하 음악이 다른 소리를 압도하면 안 된다. */
    'tournament-win': 0.09,
  };

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
    /* 홀덤 — 여기서 다루는 건 포인트가 아니라 토너먼트 칩이라 "동전 넣는" 소리가 맞지 않는다.
       칩 베팅은 두 음원을 넣어두면 playSample이 매번 무작위로 골라, 한 판에 여러 번
       울려도 기계적으로 들리지 않는다. */
    chipbet: ['chip-bet', 'chip-bet2'],
    chipwin: ['chips-to-winner'],   // 팟이 승자에게 밀려가는 소리
    /* 토너먼트 우승 — 음원 파일(public/sfx/tournament-win.mp3)은 아직 없다.
       없으면 playSample이 false를 돌려주고 기존 팡파레로 대체되므로 지금도 동작한다.
       파일을 넣는 순간 자동으로 그쪽이 쓰인다(SFX_NORM에 보정값만 재서 넣으면 된다). */
    victory: ['tournament-win'],
  };
  // 페이지가 쓰지도 않는 음원까지 받으면 WAV가 커서 낭비가 크다.
  // 각 페이지가 window.__SFX_NEED__ 로 필요한 종류만 선언한다.
  // 선언이 없으면 아무것도 받지 않는다 — 예전에는 없으면 "전부"였고, 그 탓에 소리를 쓰지 않는
  // 로비·랭킹·로그인 화면에서도 효과음 8종(1.1MB, wav 3개 포함)을 내려받아 디코딩했다.
  // 페이지 로드 400ms 뒤에 그게 시작돼 메인 스레드가 붙들리고 hover가 멈춘 채 렉이 걸렸다.
  function preloadSfx(){
    // 꺼둔 사람에게 음원 600KB를 내려받게 할 이유가 없다.
    // 나중에 켜면 playSample이 없는 버퍼를 그 자리에서 받아오므로 저절로 복구된다.
    if (!sfxOn) return;
    var need = window.__SFX_NEED__;
    if (!need || !need.length) return;
    need.forEach(function(k){ (SFX_SETS[k] || []).forEach(loadSfx); });
  }
  // 같은 소리만 반복되면 기계적으로 들려서 변형 중 하나를 무작위로 고른다.
  // 칩을 연타하면 1초 넘는 소리가 겹겹이 쌓여 지저분해지므로, 종류별로 동시에 울리는
  // 개수를 제한하고 넘치면 가장 오래된 것부터 끊는다.
  // 지뢰 연쇄 폭발은 90ms 간격으로 최대 5번 울리므로 그만큼 동시 재생을 허용한다
  /* 홀덤은 한 판에 최대 18장을 90~220ms 간격으로 돌린다. 상한이 3이면 각 딜링음이
     300ms도 못 가서 강제로 끊기고, 앞뒤가 뭉쳐 "사사삭" 하는 잡음으로 들린다.
     카드 소리는 짧아서 여러 개가 겹쳐도 지저분해지지 않으므로 넉넉히 준다. */
  var VOICES = { explode: 5, deal: 8 };
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

    var pick = ready[Math.floor(Math.random() * ready.length)];
    var src = c.createBufferSource(); src.buffer = sfxBuf[pick];
    var g = c.createGain(); g.gain.value = gain * (SFX_NORM[pick] || 1);
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
      if (playSample(kind === 'fanfare' ? 'fanfare' : 'gain', 1)) return;
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
      if (playSample('minecoin', 1)) return;
      var c = ac(); if (!c) return;
      tone(c, 1046.5, c.currentTime, 0.075, 0.05, 'triangle'); // C6
    },
    /* 버스트 — 21을 넘겨 죽는 순간의 짧고 둔탁한 "쿵".
       낙첨음(lose)과 따로 둔다: 블랙잭에서 딜러 버스트는 플레이어에게 승리라
       같은 소리를 쓰면 방금 이겼는데 진 것처럼 들린다. 합성음이라 다운로드가 없다. */
    bust: function(){
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      tone(c, 233.1, t, 0.15, 0.075, 'sawtooth');        // A#3
      tone(c, 155.6, t + 0.06, 0.30, 0.060, 'sawtooth'); // D#3
    },
    // 낙첨 — 조용히 내려가는 2음 (승리음과 반대 방향)
    lose: function(){
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      tone(c, 392.0, t, 0.14, 0.055, 'triangle');        // G4
      tone(c, 293.7, t + 0.09, 0.24, 0.045, 'triangle'); // D4
    },
    // 지뢰 — 실제 폭발음(앞부분만 잘라 씀). 연쇄 폭발은 level로 점점 작게 울린다.
    // 호출부는 내가 밟은 지뢰 0.16, 연쇄는 그보다 작은 값을 넘긴다 → 0.16을 기준(1배)으로 환산한다.
    // 절대 음량은 SFX_NORM이 잡으므로 여기서는 상대 크기만 정한다.
    boom: function(level, pitch){
      var g = level == null ? 0.16 : level;
      if (playSample('explode', Math.min(1, g / 0.16))) return;
      var c = ac(); if (!c) return;
      boomAt(c, c.currentTime, g, pitch);
    },
    /* 홀덤 칩 베팅 — 칩을 테이블에 내려놓는 소리. 두 음원 중 하나가 무작위로 난다. */
    chipBet: function(){
      if (playSample('chipbet', 1)) return;
      var c = ac(); if (!c) return;
      clinkAt(c, c.currentTime, 0.05);   // 음원이 아직 안 받아졌을 때만 쓰는 대체음
    },
    // 토너먼트 우승 — 전용 음원이 없으면 팡파레로 대체한다
    victory: function(){
      if (playSample('victory', 1)) return;
      this.win('fanfare');
    },
    // 팟이 승자에게 밀려가는 소리 (홀덤 핸드 종료)
    chipWin: function(){
      if (playSample('chipwin', 1)) return;
      this.win();
    },
    // 칩 올리기 — 동전 넣는 소리 (동전·골드바 공통)
    chip: function(){
      if (playSample('coin', 1)) return;
      var c = ac(); if (!c) return;   // 샘플이 아직 안 받아졌을 때만 쓰는 대체음
      var t = c.currentTime;
      clinkAt(c, t, 0.05);
      tone(c, 3136.0, t + 0.005, 0.10, 0.030, 'triangle'); // G7
      tone(c, 4186.0, t + 0.020, 0.08, 0.019, 'triangle'); // C8
      tone(c, 2349.0, t + 0.034, 0.13, 0.015, 'sine');     // D7 — 살짝 남는 여운
    },
    // 카드 공개 — 뒤집는 소리
    card: function(){
      if (playSample('card', 1)) return;
      var c = ac(); if (!c) return;
      clinkAt(c, c.currentTime, 0.028);
    },
    // 새 라운드 시작 — 카드 섞는 소리
    /* 셔플 소리(약 2초)는 기본 크기로 쓰면 그 뒤에 이어지는 딜링음을 덮는다.
       홀덤처럼 셔플 직후 카드를 여러 장 돌리는 곳은 작게 깔라고 인자를 받는다. */
    shuffle: function(gain){ playSample('shuffle', gain == null ? 1 : gain); },
    // 카드를 한 장 나눠줄 때
    deal: function(){ playSample('deal', 1); }
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

  // 헤더 스피커 버튼 — 켜고 끄기. 이 파일은 헤더 DOM이 생기기 전에 실행되므로 위임으로 받는다.
  window.casinoSfxToggle = function(){
    sfxOn = !sfxOn;
    try { localStorage.setItem(SFX_KEY, sfxOn ? 'on' : 'off'); } catch(e){}
    markSfxState();
    if (sfxOn) {
      preloadSfx();
      // 켠 직후 아무 소리도 안 나면 정말 켜진 건지 알 수 없다. 짧게 한 번 들려준다.
      if (window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
    }
    return sfxOn;
  };
  document.addEventListener('click', function(e){
    var t = e.target;
    var btn = t && t.closest ? t.closest('#sfxBtn') : null;
    if (!btn) return;
    var on = window.casinoSfxToggle();
    btn.setAttribute('aria-pressed', on ? 'false' : 'true');
    btn.setAttribute('title', on ? '효과음 끄기' : '효과음 켜기');
  });

  // 오디오 컨텍스트는 사용자 조작이 있어야 재생이 풀리므로 첫 클릭에서 깨운다.
  document.addEventListener('pointerdown', function(){ gestureSeen = true; ac(); preloadSfx(); }, { once: true });
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
  // 진단 로그는 URL에 ?perf=1 을 붙였을 때만 남긴다.
  // (원인은 브라우저 확장으로 특정됐지만, 다시 볼 일이 있을 때 바로 켤 수 있게 남겨둔다)
  var PERF = location.search.indexOf(perf=1) >= 0;
  window.__casinoMarks = [];
  window.casinoMark = function(label){
    if (!PERF) return;
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
        if (!PERF || e.duration < 120) return;
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
        if (PERF && e.duration >= 120) {
          console.warn('[카지노] (longtask) ' + Math.round(e.duration) + 'ms @ ' + Math.round(e.startTime) + 'ms');
        }
      });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  window.addEventListener('load', function(){ window.casinoMark('load 완료'); });
  window.casinoMark('app.js 실행 완료');
})();

/* ── 규칙 도움말 창 ──────────────────────────────────────────────────
   네이티브 <dialog>라 Esc 닫기·포커스 가둠·배경 처리는 브라우저가 해준다.
   여기서는 열고 닫는 것과 "배경을 눌러 닫기"만 붙인다.
   이 파일은 <head>에서 실행돼 DOM이 아직 없으므로 document에 위임한다. */
(function(){
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t.closest) return;

    var open = t.closest('[data-help]');
    if (open) {
      var dlg = document.getElementById(open.getAttribute('data-help'));
      if (dlg && dlg.showModal && !dlg.open) dlg.showModal();
      return;
    }
    if (t.closest('[data-help-close]')) {
      var d = t.closest('dialog');
      if (d) d.close();
      return;
    }
    // 배경(dialog 자신)을 눌렀을 때만 닫는다 — 내용 위 클릭은 그대로 통과시킨다
    if (t.tagName === 'DIALOG' && t.classList.contains('helpdlg')) t.close();
  });

  // Esc 닫기는 <dialog>가 기본으로 해주지만, 그 기본 동작이 막히는 환경이 있어 직접도 처리한다.
  // 이미 닫힌 창에 close()를 불러도 아무 일도 일어나지 않으므로 두 경로가 겹쳐도 무해하다.
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    var open = document.querySelector('dialog.helpdlg[open]');
    if (open) open.close();
  });
})();

/* ── 프로필 드롭다운 ────────────────────────────────────────────────
   이 파일은 <head>에서 동기로 실행되므로 이 시점에는 헤더 DOM이 아직 없다.
   그래서 요소를 미리 붙잡지 않고 document에 위임해서 클릭이 일어난 순간에 찾는다.
   (요소를 붙잡는 방식으로 짰다가 getElementById가 null이라 메뉴가 아예 안 열렸다) */
(function(){
  function el(id){ return document.getElementById(id); }
  function close(){
    var b = el('profBtn'), m = el('profMenu');
    if (!m || !b) return;
    m.setAttribute('hidden', '');
    b.classList.remove('open');
    b.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', function(e){
    var t = e.target;
    var inBtn = t.closest ? t.closest('#profBtn') : null;
    var inMenu = t.closest ? t.closest('#profMenu') : null;
    if (inMenu) return;                 // 메뉴 안(로그아웃 링크 등) 클릭은 그대로 통과
    if (!inBtn) return close();         // 바깥 클릭이면 닫는다
    var b = el('profBtn'), m = el('profMenu');
    if (!b || !m) return;
    if (m.hasAttribute('hidden')) {
      m.removeAttribute('hidden');
      b.classList.add('open');
      b.setAttribute('aria-expanded', 'true');
    } else close();
  });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
})();
