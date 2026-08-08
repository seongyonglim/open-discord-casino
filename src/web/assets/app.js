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
                  'tournament-win':'mp3',
                  'act-allin':'mp3', 'act-bet':'mp3', 'act-call':'mp3',
                  'act-check':'mp3', 'act-raise':'mp3', 'act-fold':'mp3', 'fold-slide':'mp3',
                  'my-turn':'mp3',
                  'win-pot':'mp3', 'clock-warn':'mp3', 'allin-bgm':'mp3' };
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
    /* 홀덤 액션 음성(All-In · Bet · Call · Check · Raise · Fold) — 음원을 새로 교체했다.
       실측 RMS: 올인 -28.9 · 벳 -32.0 · 콜 -33.1 · 체크 -33.6 · 레이즈 -32.9 · 폴드 -31.9dB.
       (새 셋은 원본끼리 이미 4.7dB 안에 들어 있다. 예전 셋은 6.8dB로 벌어져 있었다.)

       이 소리는 칩 소리와 "동시에" 난다. 그래서 기준선(-32dB)에 그대로 맞추면 둘이
       같은 크기로 부딪혀 서로를 갉아먹는다. 목소리는 잡음보다 알아듣기 쉬우므로
       1dB 낮은 -33dB에 맞춰도 충분히 들리고, 칩 소리가 주된 촉감으로 남는다.
       올인만 -31dB로 2dB 올렸다 — 판을 통째로 거는 순간이라 다른 액션과 같으면 안 된다.
       보정 후 피크는 전부 -12dB 이하라 클리핑 여유가 넉넉하다. */
    'act-allin': 0.785, 'act-bet': 0.891, 'act-call': 1.012,
    'act-check': 1.072, 'act-raise': 0.989, 'act-fold': 0.881,
    /* 카드가 미끄러지는 소리. 원본이 아주 조용하다 — 전체 RMS -50.6dB · 피크 -29.1dB.
       파일 1.44초 가운데 실제로 소리가 나는 구간은 짧아서, 전체 RMS 로 맞추면 무음에
       희석된 값을 기준 삼게 된다. 그래서 이 하나는 "가장 큰 100ms 구간"으로 잰다:
         fold-slide -42.2dB · act-fold -23.2dB(보정 후 -24.3dB)
       이 소리는 폴드 음성 위에 겹쳐 나는 촉감이므로 음성보다 4dB 아래(-28.3dB)에 둔다 —
       같은 높이로 두면 목소리를 갉아먹고, 더 낮추면 아예 안 들린다.
       보정 후 피크는 -15.2dB 라 클리핑 여유가 넉넉하다. */
    'fold-slide': 4.9,
    /* 내 차례 알림. 실측 RMS -39.2dB · 피크 -25.0dB · 1.25초.
       이것도 짧은 알림이라 전체 RMS 대신 "가장 큰 100ms 구간"으로 잰다(-33.6dB).
       액션 음성과 같은 높이(-24dB)에 둔다 — 더 낮추면 판이 시끄러울 때 묻히고,
       더 올리면 남의 액션 소리를 누른다. 이건 놓치면 자동 폴드되는 알림이라
       묻히는 쪽이 더 나쁜 실패다. 보정 후 피크 -15.3dB. */
    'my-turn': 3.0,
    /* 팟 획득 음악. 실측 RMS -33.5dB · 4.61초.
       칩이 밀려가는 소리(chips-to-winner, 실효 -31.0dB) 위에 겹쳐 깔린다. 지속음이라
       같은 RMS로 맞추면 짧은 칩 소리보다 훨씬 크게 느껴져서 3dB 아래(-34dB)에 둔다 —
       칩 소리가 앞에 서고 이건 뒤에서 부풀어야 한다. */
    'win-pot': 0.94,
    /* 제한 시간 경고(똑딱). 실측 RMS -48.6dB인데 피크는 -22.5dB다 —
       사이가 거의 무음인 임펄스라 RMS가 실제 체감보다 훨씬 낮게 나온다.
       그래서 이 하나만 RMS가 아니라 피크로 맞춘다: 보정 후 피크 -12.1dB로
       팟 음악과 같은 높이가 된다(실효 RMS는 -38.1dB). */
    'clock-warn': 3.3,
    /* 올인 순간의 음악. 실측 RMS -35.6dB · 4.39초.
       "올인" 음성(실효 -31dB)이 말을 하고 이건 분위기만 깔면 되므로 3dB 아래(-34dB)에 둔다.
       음성을 덮으면 무슨 액션인지 안 들린다. */
    'allin-bgm': 1.2,
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
    /* 도전과제 해금 — 음원 파일(public/sfx/achievement-unlock.mp3)은 아직 없다.
       우승 음원과 같은 방식으로, 없으면 아래의 합성 팡파레가 대신 울리고 파일을 넣는
       순간 자동으로 그쪽이 쓰인다. */
    achievement: ['achievement-unlock'],
    /* 홀덤 액션 음성. 칩 소리를 "대체"하지 않고 그 위에 겹쳐 낸다 —
       칩 소리는 "돈이 나갔다", 이 소리는 "무슨 행동을 했다"로 역할이 다르다.
       체크는 칩이 나가지 않으므로 이 소리만 난다(그래서 체크가 조용하지 않게 된다). */
    actallin: ['act-allin'],
    actbet: ['act-bet'],
    actcall: ['act-call'],
    actcheck: ['act-check'],
    actraise: ['act-raise'],
    actfold: ['act-fold'],
    /* 카드가 미끄러지는 소리 — 음성(act-fold) 위에 겹쳐 낸다. 음성은 '무슨 행동을
       했다'이고 이건 카드가 실제로 밀려나는 그 순간의 촉감이다. */
    foldslide: ['fold-slide'],
    /* 아래 셋은 "한 번에 하나만" 울려야 하는 소리다(VOICES에서 상한 1).
       겹쳐 울리면 음악이 두 겹으로 깔려 무슨 일이 일어났는지 오히려 흐려진다.
       상한이 1이면 playSample이 새로 시작할 때 이전 것을 끊는다 —
       올인 리레이즈에서 "이전 노래를 끊고 다시" 라는 동작이 여기서 나온다. */
    potwin: ['win-pot'],        // 팟 획득 — 칩 소리 위에 겹쳐 깔린다
    clockwarn: ['clock-warn'],  // 제한 시간 5초 미만
    /* 내 차례가 열렸다. 차례의 주인에게만 울린다 — 부르는 쪽이 그것을 판단한다.
       한 번에 하나만 울려야 하므로 아래 VOICES 에서 상한 1 을 준다. */
    myturn: ['my-turn'],
    allinbgm: ['allin-bgm'],    // 올인(콜이 우연히 올인이 된 경우는 제외)
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
  /* 상한 1인 것들은 "겹치지 않는 음악"이다. 두 번째 호출이 오면 playSample이
     가장 오래된(= 유일한) 재생을 끊고 새로 시작한다. 올인 리레이즈에서 앞 음악을
     끊고 다시 트는 동작이 이 한 줄에서 나온다. */
  var VOICES = { explode: 5, deal: 8, potwin: 1, clockwarn: 1, allinbgm: 1, myturn: 1 };
  var DEFAULT_VOICES = 3;
  var playing = {};

  /* ── 액션 목소리는 줄을 세워 내보낸다 ────────────────────────────────
     칩·카드 소리는 겹쳐도 자연스럽지만 말소리는 다르다. 두 사람의 목소리가 겹치면
     둘 다 안 들린다.

     홀덤은 다음 사람이 미리 액션을 지정해 둘 수 있어서(자동 체크·자동 콜), 내가 누른
     직후 0.1초 만에 다음 액션이 처리되는 일이 흔하다. 그때 "콜"과 "체크"가 한 덩어리로
     뭉개져 들렸다.

     그래서 앞 목소리가 끝날 때까지 기다렸다가 다음을 낸다. 다만 무한정 기다리지는 않는다 —
     0.8초를 넘기면 화면의 액션 표시보다 소리가 뒤처져서 누구 소리인지 알 수 없게 된다.

     ── 버리지 않는다
     예전에는 밀린 것이 3개를 넘으면 오래된 것부터 버렸다. 그 결과 베팅 라운드가 길어지면
     액션 소리가 간헐적으로 아예 안 났다: 폴링 한 번에 봇 액션 두세 개가 함께 도착하고,
     0.8초 간격으로만 빠지니 큐가 계속 쌓여 넘친 만큼 조용히 사라진 것이다.

     이제는 버리는 대신 간격을 좁혀 따라잡는다. 밀린 것이 둘 이상이면 0.38초로 붙여 내보낸다 —
     두 낱말이 조금 겹치더라도 알아들을 수 있고, 아무 소리도 안 나는 것보다 낫다.
     진짜 폭주(8개 초과)에서만 버린다. 그건 정상 진행에서 나올 수 없는 수다. */
  var VOICE_MAX_GAP_MS = 800;
  var VOICE_MIN_GAP_MS = 380;   // 밀렸을 때 따라잡는 간격
  var VOICE_QUEUE_MAX = 8;      // 이걸 넘기면 폭주다 (정상 진행에서는 3을 넘지 않는다)
  var voiceQueue = [], voiceFreeAt = 0, voiceTimer = null;

  function voiceLenMs(set){
    var names = SFX_SETS[set] || [];
    for (var i = 0; i < names.length; i++) {
      var b = sfxBuf[names[i]];
      if (b) return Math.min(b.duration * 1000 + 60, VOICE_MAX_GAP_MS);
    }
    return 400;   // 아직 안 받아졌으면 대략치로 잡는다
  }
  // 밀린 게 많을수록 붙여 낸다 — 하나라도 버리지 않고 화면과의 시차를 줄인다
  function voiceGapMs(set){
    return voiceQueue.length >= 2 ? VOICE_MIN_GAP_MS : voiceLenMs(set);
  }
  function voiceDrain(){
    voiceTimer = null;
    var next = voiceQueue.shift();
    if (!next) return;
    voiceFreeAt = Date.now() + voiceGapMs(next[0]);
    playSample(next[0], next[1]);
    if (voiceQueue.length) voiceTimer = setTimeout(voiceDrain, Math.max(0, voiceFreeAt - Date.now()));
  }
  function speak(set, gain){
    var now = Date.now();
    if (now >= voiceFreeAt && !voiceQueue.length) {
      voiceFreeAt = now + voiceLenMs(set);
      playSample(set, gain);
      return;
    }
    voiceQueue.push([set, gain]);
    /* 여기서 버리면 그 액션은 소리가 아예 안 난다. 상한을 넉넉히 두고, 넘어가면
       간격이 스스로 좁혀져(voiceGapMs) 따라잡으므로 실제로는 여기까지 오지 않는다. */
    while (voiceQueue.length > VOICE_QUEUE_MAX) voiceQueue.shift();
    if (!voiceTimer) voiceTimer = setTimeout(voiceDrain, Math.max(0, voiceFreeAt - now));
  }

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
    /* 팟 획득 음악. chipWin을 "대체"하지 않고 그 위에 겹쳐 깔린다 —
       칩 소리는 "돈이 움직였다", 이건 "이겼다"로 역할이 다르다.
       사이드 팟을 층마다 나눠 줄 때는 층마다 다시 호출되고, 상한이 1이라
       앞 음악이 끊기고 새로 시작한다(층이 넘어간 것이 소리로도 드러난다). */
    potWin: function(){ playSample('potwin', 1); },
    /* 제한 시간 5초 미만. 한 차례에 한 번만 호출해야 한다(4.6초짜리 똑딱 소리라
       매초 부르면 겹쳐서 뭉개진다). 호출부가 자리마다 한 번씩만 부른다. */
    clockWarn: function(){ playSample('clockwarn', 1); },
    /* 내 차례가 열렸다. 부르는 쪽(홀덤 화면)이 "내 차례인가"를 판단해서 부른다 —
       여기서는 누구의 차례인지 알 수 없고, 알 필요도 없다. */
    myTurn: function(){ playSample('myturn', 1); },
    /* 도전과제 해금 — 짧게 올라가는 네 음. 승리음(win)과 달라야 한다:
       그건 "이 판을 이겼다"이고 이건 "계정에 뭔가 남았다"라 성격이 다르다.
       그래서 더 밝고(장3화음 위로) 더 짧게 끝낸다. 음원 파일이 들어오면 그쪽이 이긴다. */
    achievement: function(){
      if (playSample('achievement', 1)) return;
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      var notes = [783.99, 987.77, 1174.7, 1567.98];   // G5 B5 D6 G6
      notes.forEach(function(f, i){
        tone(c, f, t + i * 0.07, 0.20, 0.070 - i * 0.008, 'triangle');
      });
      tone(c, 1975.5, t + 0.30, 0.42, 0.030, 'sine');  // 끝에 남는 반짝임 (B6)
    },
    /* 올인 음악. 판을 통째로 거는 순간에만 부른다 — 남의 올인에 콜했는데 그게
       우연히 내 스택 전부였던 경우는 부르지 않는다(그건 콜이다).
       더 큰 금액으로 다시 올인하면 다시 부르면 되고, 상한이 1이라 앞 음악이 끊긴다. */
    allinBgm: function(){ playSample('allinbgm', 1); },
    /* 홀덤 액션 음성 — 서버가 쓰는 행동 이름(fold/check/call/bet/raise/allin)을 그대로 받는다.
       칩 소리와 별개로 호출하는 것이 중요하다: 칩 소리를 이걸로 갈아치우면 안 된다.

       여섯 액션 모두 음성이 있다(폴드는 나중에 따로 받았다).
       speak()로 내보내므로 앞 목소리가 끝난 뒤에 나간다 — 겹치면 둘 다 안 들린다.
       음원이 아직 안 받아졌으면 playSample이 false를 돌려주고 아무 일도 일어나지 않는다. */
    action: function(kind){
      var set = kind === 'allin' ? 'actallin'
        : kind === 'bet' ? 'actbet'
        : kind === 'call' ? 'actcall'
        : kind === 'check' ? 'actcheck'
        : kind === 'raise' ? 'actraise'
        : kind === 'fold' ? 'actfold' : null;
      if (set) speak(set, 1);
      /* 폴드에는 카드가 미끄러지는 소리를 겹쳐 낸다. 음성은 "무슨 행동을 했다"이고
         이건 카드가 실제로 밀려나는 그 순간의 촉감이라 역할이 다르다.
         음성보다 4dB 아래로 맞춰 뒀으므로 목소리를 덮지 않는다. */
      if (kind === 'fold') playSample('foldslide', 1);
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

/* ── 우측 패널 탭 (참가인원 / 랭킹) ──────────────────────────────────
   hidden 속성이 아니라 .on 클래스로 전환한다 — pane에 display:flex가 필요한데
   display를 명시하면 hidden 속성이 밀린다(이 프로젝트에서 세 번 겪은 함정이다).
   이 파일은 <head>에서 실행돼 DOM이 아직 없으므로 document에 위임한다. */
(function(){
  document.addEventListener('click', function(e){
    if (!e.target.closest) return;
    var t = e.target.closest('[data-sptab]');
    if (!t) return;
    var box = t.closest('.game-side');
    if (!box) return;
    var id = t.getAttribute('data-sptab');
    box.querySelectorAll('.sp-tab').forEach(function(b){
      var on = (b === t);
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    box.querySelectorAll('.sp-pane').forEach(function(p){
      p.classList.toggle('on', p.id === id);
    });
    // 랭킹 탭을 열면 그 즉시 한 번 당겨온다 (30초 주기를 기다리지 않는다)
    if (id.slice(-5) === '-rank' && window.__spRankOpen) window.__spRankOpen();
  });
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

/* ── 알림 종 ────────────────────────────────────────────────────────
   머리에 달린 종. 안 읽은 개수를 배지로 띄우고, 누르면 목록을 연다.

   개수를 서버가 처음 그릴 때 넣지 않는 이유: 모든 페이지가 같은 머리를 쓰는데 거기에
   사람마다 다른 숫자가 들어가면 산출물을 바이트로 비교하는 검사가 매번 다르다고 한다.
   그래서 열자마자 한 번 받아 채운다.

   주기적으로 다시 묻지 않는다. 알림은 초를 다투는 정보가 아니고, 페이지를 오갈 때마다
   새로 받으므로 그것으로 충분하다 — 1초 폴링을 하나 더 얹으면 그만큼 요금이 된다.
   달성 팝업만은 게임 쪽에서 즉시 띄운다(casinoNotify.toast). */
(function(){
  function el(id){ return document.getElementById(id); }
  /* 요소를 여기서 붙잡아 두면 안 된다. 이 파일은 <head> 에서 동기로 실행되므로
     그 시점에는 헤더가 아직 파싱되기 전이고, getElementById 는 전부 null 이다 —
     처음에 그렇게 만들었다가 종이 통째로 죽었다(배지도 목록도 영영 안 떴다).
     그래서 쓸 때마다 찾고, 클릭은 document 위임으로 받는다(프로필 메뉴와 같은 이유다). */
  function btnEl(){ return el('belBtn'); }
  function menuEl(){ return el('belMenu'); }
  var loaded = false;

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(sec){
    var d = Math.floor(Date.now() / 1000) - sec;
    if (d < 60) return '방금';
    if (d < 3600) return Math.floor(d / 60) + '분 전';
    if (d < 86400) return Math.floor(d / 3600) + '시간 전';
    return Math.floor(d / 86400) + '일 전';
  }
  var TYPE_ICON = {
    ANNOUNCEMENT: '📢', ACHIEVEMENT: '🏆', POINT_GIFT: '🎁', SYSTEM: '⚙️'
  };

  function paintBadge(n){
    var badge = el('belBadge');
    if (!badge) return;
    if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = false; }
    else badge.hidden = true;
  }
  function paint(d){
    var items = (d && d.items) || [];
    paintBadge(d ? d.unread : 0);
    var list = el('belList');
    if (!list) return;
    if (!items.length) { list.innerHTML = '<div class="bel-empty">알림이 없습니다</div>'; return; }
    list.innerHTML = items.map(function(n){
      var ic = TYPE_ICON[n.type] || '•';
      var inner = '<span class="bel-ic">' + ic + '</span>'
        + '<span class="bel-mid"><span class="bel-t">' + esc(n.title) + '</span>'
        + '<span class="bel-m">' + esc(n.message) + '</span></span>'
        + '<span class="bel-w">' + ago(n.createdAt) + '</span>';
      var cls = 'bel-row' + (n.read ? '' : ' unread');
      return n.link
        ? '<a class="' + cls + '" href="' + esc(n.link) + '">' + inner + '</a>'
        : '<div class="' + cls + '">' + inner + '</div>';
    }).join('');
  }
  function load(){
    if (!btnEl()) return Promise.resolve();   // 로그인 안 한 화면에는 종이 없다
    return fetch('/api/notifications')
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.ok) return;
        loaded = true;
        paint(d);
        /* 하루 안에 올라온, 아직 안 읽은 공지는 접속하자마자 띄운다 —
           종에만 넣어 두면 배지를 안 누른 사람에게는 없는 것과 같다. */
        if (window.__casinoPopups) window.__casinoPopups(d.popup);
      })
      .catch(function(){ /* 실패해도 화면은 그대로 둔다 */ });
  }
  /* 배지만 먼저 채운다 — 목록은 열 때 받는다.
     헤더가 만들어진 뒤여야 하므로 DOM 이 준비되면 부른다. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ load(); });
  } else load();

  function close(){
    var menu = menuEl(), btn = btnEl();
    if (!menu || !btn) return;
    menu.setAttribute('hidden', '');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function open(){
    var menu = menuEl(), btn = btnEl();
    if (!menu || !btn) return;
    menu.removeAttribute('hidden');
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    if (!loaded) load();
    /* 연 것 자체를 읽음으로 본다. 줄마다 눌러야 지워지면 배지가 며칠씩 남는다 —
       배지는 "새 소식이 있다"는 뜻이지 "처리할 일이 있다"는 뜻이 아니다.
       화면의 굵은 표시는 그대로 두고 배지만 내린다(무엇이 새 것이었는지는 보여야 한다). */
    fetch('/api/notifications/read-all', { method: 'POST' })
      .then(function(){ paintBadge(0); })
      .catch(function(){ });
  }
  document.addEventListener('click', function(e){
    var t = e.target;
    var inBtn = t.closest ? t.closest('#belBtn') : null;
    var inMenu = t.closest ? t.closest('#belMenu') : null;
    if (inMenu) {
      if (t.closest && t.closest('#belAllRead')) {
        fetch('/api/notifications/read-all', { method: 'POST' }).then(load);
      }
      return;
    }
    if (!inBtn) return close();
    var menu = menuEl();
    if (menu && menu.hasAttribute('hidden')) open(); else close();
  });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });

  /* ── 달성 토스트 ──────────────────────────────────────────────────
     오른쪽 위에서 미끄러져 들어온다. 게임 쪽이 응답에서 달성을 받으면 부른다:
       window.casinoNotify.toast({ title: '도전과제 달성!', message: '...' })
     여러 개가 한꺼번에 와도 겹치지 않게 세로로 쌓는다. */
  /* 어떤 게임의 응답이든 달성이 실려 오면 잡는다.
     게임마다 따로 배선하면 어떤 게임은 팝업이 뜨고 어떤 게임은 조용해진다 — 게임이
     일곱 개인데 새 과제를 붙일 때마다 일곱 곳을 확인해야 한다는 뜻이다.
     그래서 fetch 를 한 겹 감싸 같은 서버의 /api/ 응답만 들여다본다.

     반드시 clone() 으로 읽어야 한다. 원본 본문을 읽으면 게임 쪽에서 다시 못 읽어
     화면이 통째로 죽는다. 실패는 전부 삼킨다 — 이건 곁다리 기능이라, 여기서 나는
     오류가 게임을 멈추게 해서는 안 된다. */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function(input, init){
      var out = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/') !== 0) return out;
        // 알림 API 자신은 건너뛴다 — 스스로를 다시 부르는 고리를 만들지 않는다
        if (url.indexOf('/api/notifications') === 0) return out;
        return out.then(function(r){
          try {
            var ct = r.headers && r.headers.get && r.headers.get('content-type');
            if (r.ok && ct && ct.indexOf('json') >= 0) {
              r.clone().json().then(function(d){
                var list = d && d.unlocked;
                if (list && list.length) {
                  list.forEach(function(a, i){
                    // 둘이 동시에 달성되면 겹치지 않게 조금씩 늦춘다
                    setTimeout(function(){
                      window.casinoNotify.toast({ title: '도전과제 달성!', message: a.title });
                    }, i * 700);
                  });
                }
              }).catch(function(){ });
            }
          } catch (e) { }
          return r;
        });
      } catch (e) { return out; }
    };
  }

  var stack = null;
  function ensureStack(){
    if (stack) return stack;
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
    return stack;
  }
  /* 종류마다 모양이 다르다. 달성은 금색 트로피에 소리가 나고, 공지는 조용히 뜬다 —
     같은 소리를 내면 "뭔가 해냈다"와 "읽을 것이 있다"가 구분되지 않는다. */
  var TOAST_KIND = {
    ACHIEVEMENT: { cls: 'ach', ic: '🏆', head: '도전과제 달성!', sfx: true },
    ANNOUNCEMENT: { cls: 'noti', ic: '📢', head: '새 공지사항', sfx: false },
    POINT_GIFT: { cls: 'noti', ic: '🎁', head: '포인트', sfx: false },
    SYSTEM: { cls: 'noti', ic: '⚙️', head: '알림', sfx: false }
  };
  function toast(o){
    o = o || {};
    var k = TOAST_KIND[o.type] || TOAST_KIND.ACHIEVEMENT;
    var s = ensureStack();
    /* 누를 곳이 있으면 링크로 만든다 — 공지 팝업은 "가서 읽어라"가 요점이라
       띄워 놓고 갈 방법이 없으면 종을 다시 열어 찾아야 한다. */
    var d = document.createElement(o.link ? 'a' : 'div');
    d.className = 'toast ' + k.cls;
    if (o.link) d.setAttribute('href', o.link);
    d.innerHTML = '<span class="toast-ic">' + k.ic + '</span>'
      + '<span class="toast-mid"><span class="toast-t">' + esc(o.title || k.head) + '</span>'
      + '<span class="toast-m">' + esc(o.message || '') + '</span></span>';
    s.appendChild(d);
    // 다음 프레임에 클래스를 붙여야 들어오는 동작이 보인다 (붙인 채로 넣으면 이미 제자리다)
    requestAnimationFrame(function(){ d.classList.add('in'); });
    if (k.sfx && window.casinoSfx && window.casinoSfx.achievement) window.casinoSfx.achievement();
    setTimeout(function(){
      d.classList.remove('in');
      setTimeout(function(){ if (d.parentNode) d.parentNode.removeChild(d); }, 400);
    }, o.link ? 8000 : 5000);   // 누를 것이 있으면 조금 더 세워 둔다
  }

  /* 공지 팝업은 이 브라우저에서 한 번만 뜬다.
     서버에 "띄웠다"를 적지 않는 이유: 그러려면 읽음으로 표시해야 하는데, 그러면 배지가
     같이 사라져서 아직 안 읽은 공지가 안 읽은 것으로 안 보이게 된다. 팝업을 봤다는 것과
     내용을 읽었다는 것은 다르다. 그래서 표시는 이 브라우저에만 남긴다 —
     기기가 둘이면 양쪽에서 한 번씩 뜨는데, 그건 오히려 맞는 동작이다. */
  function popped(id){
    try { return localStorage.getItem('od_noti_pop_' + id) === '1'; } catch (e) { return false; }
  }
  function markPopped(id){
    try { localStorage.setItem('od_noti_pop_' + id, '1'); } catch (e) { }
  }
  function showPopups(list){
    if (!list || !list.length) return;
    var n = 0;
    list.forEach(function(item){
      if (popped(item.id)) return;
      markPopped(item.id);
      // 여럿이면 겹치지 않게 조금씩 늦춘다
      setTimeout(function(){
        toast({ type: item.type, title: item.title, message: item.message, link: item.link });
      }, n * 700);
      n++;
    });
  }

  window.casinoNotify = {
    refresh: load,
    toast: function(o){ toast(o); load(); }
  };
  window.__casinoPopups = showPopups;   // load() 가 응답을 받으면 넘겨준다
})();
