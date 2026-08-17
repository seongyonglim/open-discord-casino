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

  /* ── 음량 ────────────────────────────────────────────────────────────
     예전에는 켜기/끄기 둘뿐이었다. 스피커 환경이 제각각이라 "켜면 너무 크고 끄면
     아무것도 안 들리는" 사이가 없었다 — 그래서 0~100%를 따로 둔다.

     값을 둘로 나눠 기억한다.
       od_sfx : 음소거인가        od_vol : 음량 0~1
     하나로 합쳐 "0이면 음소거"로 두면 껐다 켤 때 원래 크기를 잃는다. 끄기 직전 값으로
     돌아오게 하는 것이 값을 둘로 두는 이유다.

     설정은 브라우저에만 남긴다(서버에 저장할 이유가 없다 — 같은 사람이라도 회사 PC에서는
     끄고 집에서는 켜고 싶을 수 있다).
     이 파일은 <head>에서 동기 실행되므로 <html>에 상태 클래스를 미리 박아 둔다.
     그래야 헤더가 그려지는 첫 순간부터 아이콘이 올바른 모양으로 나온다(깜빡임 방지). */
  var SFX_KEY = 'od_sfx';
  var VOL_KEY = 'od_vol';
  var VOL_HALF = 0.5;          // 여기까지가 "작은 소리" 아이콘
  var sfxOn = true;
  var vol = 1;
  try { sfxOn = localStorage.getItem(SFX_KEY) !== 'off'; } catch(e){}
  try {
    // NaN이면 아래 두 비교가 모두 거짓이라 기본값 1이 그대로 남는다
    var stored = parseFloat(localStorage.getItem(VOL_KEY));
    if (stored >= 0 && stored <= 1) vol = stored;
  } catch(e){}
  // 실제로 소리에 곱해지는 값. 음소거면 0이다 — 이 값만 보면 되도록 한 곳에 모은다.
  function masterLevel(){ return sfxOn ? vol : 0; }
  function markSfxState(){
    var r = document.documentElement;
    if (!r) return;
    var v = masterLevel();
    r.classList.toggle('sfx-off', v <= 0);
    r.classList.toggle('sfx-low', v > 0 && v <= VOL_HALF);
  }
  markSfxState();

  function ac(){
    // 소리가 0이면 아예 컨텍스트를 열지 않는다.
    // 소리를 내는 모든 경로가 ac()의 null을 확인하고 빠져나가므로, 여기 한 곳만 막으면 된다
    // (합성음 대체 경로까지 포함해서).
    if (masterLevel() <= 0) return null;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch(e) { return null; }
    }
    if (gestureSeen && ctx.state === 'suspended') { try { ctx.resume(); } catch(e){} }
    return ctx;
  }

  /* ── 마스터 볼륨 ─────────────────────────────────────────────────────
     모든 소리는 이 한 마디를 지나 밖으로 나간다. 소리를 낼 때마다 음량을 곱하는 식으로
     두면 새 소리를 넣는 날 곱하기를 빠뜨릴 수 있고, 빠뜨린 그 소리만 슬라이더를 무시한다.
     출구를 하나로 두면 그 실수가 애초에 불가능하다 — 새 소리는 destination이 아니라
     master(c)에 연결하면 된다. */
  var masterGain = null;
  function master(c){
    // 컨텍스트가 바뀌면(닫혔다 다시 열리면) 예전 노드는 그 컨텍스트에 묶여 쓸 수 없다
    if (!masterGain || masterGain.context !== c) {
      masterGain = c.createGain();
      masterGain.gain.value = masterLevel();
      masterGain.connect(c.destination);
    }
    return masterGain;
  }
  // 슬라이더를 움직이는 동안에도 이미 울리고 있는 소리가 같이 따라와야 한다.
  // 값을 그대로 꽂으면 파형이 끊겨 "톡" 소리가 나므로 아주 짧게 미끄러뜨린다.
  function applyLevel(){
    if (!masterGain) return;
    try { masterGain.gain.setTargetAtTime(masterLevel(), masterGain.context.currentTime, 0.015); }
    catch(e) { masterGain.gain.value = masterLevel(); }
  }
  function tone(c, freq, at, dur, peak, type){
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(master(c));
    o.start(at); o.stop(at + dur + 0.02);
  }
  /* 노이즈 한 겹. 총성처럼 "여러 겹을 겹쳐 만드는 소리"를 위한 재료다.
     boomAt 과 나누는 이유는 boomAt 이 폭발 하나에 맞춰 굳은 값을 들고 있어서다
     (저역 고정, 0.32초, 감쇠 지수 2.2). 총성은 겹마다 필터 종류와 길이가 달라야 한다.
     from → to 로 필터를 훑는 것이 핵심이다 — 고정 필터로는 "때리는 느낌"이 안 난다. */
  function noiseBurst(c, at, dur, level, filterType, from, to){
    var buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.6);
    }
    var src = c.createBufferSource(); src.buffer = buf;
    var f = c.createBiquadFilter(); f.type = filterType;
    f.frequency.setValueAtTime(from, at);
    /* exponentialRamp 는 0 을 못 받는다(0 이면 소리가 통째로 사라진다).
       같은 값이면 램프를 걸지 않는다 — 격발 겹은 훑지 않고 고정이다. */
    if (to !== from) f.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + dur);
    var g = c.createGain();
    g.gain.setValueAtTime(Math.max(0.0005, level), at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f); f.connect(g); g.connect(master(c));
    src.start(at); src.stop(at + dur);
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
    src.connect(lp); lp.connect(g); g.connect(master(c));
    src.start(at); src.stop(at + dur);
  }
  // 실제 녹음 샘플 (Kenney Casino Audio, CC0). 합성음보다 훨씬 자연스러워서 이쪽을 우선 쓰고,
  // 로딩 실패하거나 아직 안 받아졌으면 아래 합성음으로 대체한다.
  var sfxBuf = {};
  var SFX_EXT = { 'coin-insert':'wav', 'card-shuffle':'wav', 'win-fanfare':'wav',
                  'card-flip':'mp3', 'card-deal':'mp3',
                  'coin-gain':'mp3', 'mine-coin':'mp3', 'explode':'mp3', 'mine-perfect':'mp3',
                  'chip-bet':'mp3', 'chip-bet2':'mp3', 'chips-to-winner':'mp3',
                  'tournament-win':'mp3',
                  'act-allin':'mp3', 'act-bet':'mp3', 'act-call':'mp3',
                  'act-check':'mp3', 'act-raise':'mp3', 'act-fold':'mp3', 'fold-slide':'mp3',
                  'my-turn':'mp3',
                  'win-pot':'mp3', 'clock-warn':'mp3', 'allin-bgm':'mp3',
                  'gunshot':'mp3', 'reel-roll':'mp3', 'reel-stop':'mp3', 'bounty-earn':'mp3' };
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
    /* chip-bet2 는 0.23 이었다. 둘은 같은 동작(칩을 올린다)의 변형이라 무작위로 번갈아
       나가는데, 보정 후 실효가 -31.6 대 -34.4dB 로 2.8dB 벌어져 있었다 — 같은 행동이
       누를 때마다 다른 크기로 들렸다. 0.32 로 올려 둘을 같은 높이에 세운다(피크 -9.9dB). */
    'chip-bet': 0.24, 'chip-bet2': 0.32, 'chips-to-winner': 0.87,
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
    /* 아래 넷은 이 표에 없어서 보정 없이(1.0) 나가고 있었다. 음량 슬라이더를 넣은 뒤
       전체를 브라우저에서 다시 재 보니 그중 둘이 실제로 어긋나 있었다.

       win-pot      RMS -34.2dB · 가장 큰 100ms -22.8dB · 4.61초.
                    팟 획득 "음악"이라 전체 RMS 는 낮게 나오지만 실제로 들리는 구간은
                    다른 효과음과 같은 높이다(-22.8 대 -23 안팎). 그대로 둔다.
       allin-bgm    RMS -36.0dB · 100ms -30.7dB · 4.39초.
                    올인 순간 아래로 깔리는 배경음이라 4dB 낮은 것이 맞다. 그대로 둔다.
       clock-warn   RMS -48.6dB · 100ms -42.2dB. 다른 소리보다 19dB 낮아 게임 소리에
                    완전히 묻혔다 — 남은 시간 5초를 알리는 경고가 안 들리면 없는 것과 같다.
                    100ms 기준 -26dB 로 올린다(+16.2dB · 보정 후 피크 -6.3dB).
       mine-perfect RMS -29.8dB · 피크 -7.6dB · 4.69초. 지뢰찾기 퍼펙트 클리어 음악이다.
                    짧은 효과음 기준선(-32dB)에 맞춘다 — 우승 음악(tournament-win)과 같은
                    높이다(보정 후 피크 -9.8dB). */
    'win-pot': 1.0, 'allin-bgm': 1.0, 'clock-warn': 6.4, 'mine-perfect': 0.78,
    /* PKO 처형 총성. 실측 RMS -23.2dB · 피크 -5.3dB · 2.48초(세 발이 한 파일).
       기준선(-32dB)에 맞추면 0.365 이고 보정 후 피크는 -14dB 다.
       기준선보다 더 낮추지 않는다 — 이 소리는 대회에서 한 사람이 나갈 때만 나고,
       작으면 "처형"이 아니라 배경음이 된다. */
    'gunshot': 0.365,
    /* 미스터리 전광판·바운티 획득. 실측 RMS 는 셋이 13.7dB 나 벌어져 있어(-29.2 / -24.3 /
       -15.5dB) 보정 없이 넣으면 획득 소리 하나가 나머지를 다 덮는다.
       기준선(-31.5dB)에 맞춘다. 회전음만 2dB 더 낮춘다 — 2.05초짜리 지속음이라 짧은
       효과음과 같은 RMS 여도 훨씬 크게 느껴진다(우승 음원에 쓴 것과 같은 근거다).
         reel-roll    -29.2 → 0.610 → 실효 -33.5dB
         reel-stop    -24.3 → 0.437 → 실효 -31.5dB
         bounty-earn  -15.5 → 0.158 → 실효 -31.5dB */
    'reel-roll': 0.610, 'reel-stop': 0.437, 'bounty-earn': 0.158,
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
    /* PKO 처형 총성. 세 발이 한 파일에 들어 있다.
       이 줄이 없으면 playSample 이 이름을 못 찾아 늘 실패하고 합성음으로 떨어진다 —
       파일을 넣고 화이트리스트에 올려도 소리가 한 번도 안 나갔던 이유가 이것이다. */
    gunshot: ['gunshot'],
    /* 미스터리 전광판 — 돌아가는 소리와 멈추는 소리.
       화면 구간(MYS_ROLL_MS · MYS_LAND_MS)을 이 음원 길이에 맞춰 놓았다. 음원을 바꾸면
       그 상수도 같이 재서 바꿔야 한다 — 소리가 먼저 끝나면 무음이 생기고, 늦게 끝나면
       멈춘 뒤에도 돌아가는 소리가 남는다(seats.ts 의 그 상수 옆에도 적어 뒀다). */
    bountyearn: ['bounty-earn'],
    reelroll: ['reel-roll'],
    reelstop: ['reel-stop'],
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
    /* 지뢰찾기 퍼펙트 클리어 — 안전 칸을 하나도 남기지 않고 다 연 순간.
       한 판에 한 번뿐이라 아래 VOICES 에서 상한 1 을 준다(겹치면 음악이 뭉개진다). */
    mineperfect: ['mine-perfect'],
  };
  // 페이지가 쓰지도 않는 음원까지 받으면 WAV가 커서 낭비가 크다.
  // 각 페이지가 window.__SFX_NEED__ 로 필요한 종류만 선언한다.
  // 선언이 없으면 아무것도 받지 않는다 — 예전에는 없으면 "전부"였고, 그 탓에 소리를 쓰지 않는
  // 로비·랭킹·로그인 화면에서도 효과음 8종(1.1MB, wav 3개 포함)을 내려받아 디코딩했다.
  // 페이지 로드 400ms 뒤에 그게 시작돼 메인 스레드가 붙들리고 hover가 멈춘 채 렉이 걸렸다.
  function preloadSfx(){
    // 꺼둔 사람에게 음원 600KB를 내려받게 할 이유가 없다.
    // 나중에 켜면 playSample이 없는 버퍼를 그 자리에서 받아오므로 저절로 복구된다.
    if (masterLevel() <= 0) return;
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
  var VOICES = { explode: 5, deal: 8, potwin: 1, clockwarn: 1, allinbgm: 1, myturn: 1,
    mineperfect: 1 };
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
    src.connect(g); g.connect(master(c));
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
    src.connect(hp); hp.connect(g); g.connect(master(c));
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
    // 퍼펙트 클리어. 합성음 대체를 두지 않는다 — 이 순간에 삐 소리가 나면 없는 편이 낫다
    minePerfect: function(){ playSample('mineperfect', 1); },
    /* ── PKO 총성 ────────────────────────────────────────────────────
       음원 파일을 두지 않고 합성한다. 총성은 "짧고 크다"가 전부라 파형으로 충분히
       만들어지고, 무엇보다 다운로드가 없어야 한다 — 탈락은 판이 끝나는 순간에 터지는데
       그때 파일을 받으러 가면 소리가 연출보다 늦게 도착한다(총자국은 이미 박혀 있다).

       세 겹이다. 실제 총성이 그렇게 들린다:
         1) 격발  — 아주 짧은 고역 노이즈. "탁" 하고 때리는 부분이다.
         2) 폭발  — 저역으로 급히 내려가는 노이즈. 몸통이고 가장 크다.
         3) 잔향  — 길게 깔리는 저역. 이게 없으면 장난감 소리가 된다.
       한 겹만 쓰면 전부 "픽" 소리다(노이즈 버스트 하나로 먼저 만들어 봤다). */
    gunshot: function(){
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      // 1) 격발 — 2ms 짜리 고역 딱
      noiseBurst(c, t, 0.02, 0.20, 'highpass', 3200, 3200);
      // 2) 폭발 — 몸통. 900Hz 에서 90Hz 로 떨어지며 0.18초에 사그라든다
      noiseBurst(c, t, 0.18, 0.34, 'lowpass', 900, 90);
      // 3) 잔향 — 길고 낮게. 크기는 몸통의 1/4 이하여야 뭉개지지 않는다
      noiseBurst(c, t + 0.02, 0.42, 0.07, 'lowpass', 320, 60);
    },
    /* 처형 세 발이 든 실제 음원의 발사 시각(ms). 화면이 이 값을 읽어 총알이 박히는
       순간을 맞춘다 — 음원과 시각 효과가 어긋나면 "소리 따로 그림 따로"가 된다.

       파형에서 잰 값이다(모노 8kHz, 5ms 창 RMS, 문턱 최대치의 25%):
       앞 무음 0.93초를 잘라 낸 뒤 30 · 305 · 1335ms. 간격이 275ms 와 1030ms 로
       고르지 않은데, 그 불규칙함이 이 음원의 리듬이라 고르게 펴면 안 된다.
       음원을 바꾸면 이 배열도 같이 바꿔야 한다 — 그래서 소리 옆에 둔다. */
    gunfireShots: [30, 305, 1335],
    /* 처형 총성. 세 발이 한 파일에 들어 있어 한 번만 재생한다 — 발마다 따로 재생하면
       간격이 음원의 리듬이 아니라 우리가 정한 숫자가 되고, 그러면 총성이 어색해진다.
       음원이 아직 안 받아졌으면 합성음을 같은 시각에 세 번 낸다. */
    gunfire: function(){
      if (playSample('gunshot', 1)) return;
      var self = this;
      this.gunfireShots.forEach(function(ms, i){
        if (i === 0) self.gunshot();
        else setTimeout(function(){ self.gunshot(); }, ms - self.gunfireShots[0]);
      });
    },
    /* ── 미스터리 바운티 전광판 ──────────────────────────────────────
       한동안 여기에 상자 소리(덜커덩 + 뚜껑 열림)가 있었다. 연출을 전광판으로 바꾸면서
       그 소리는 화면과 아무 상관이 없어졌다 — 이름도 내용도 없는 물건을 가리키고 있었다.

       그 뒤에는 숫자가 바뀔 때마다 짧은 딸깍을 냈다. 회전 음원이 들어오면서 그것도
       필요가 없어졌다: 음원 길이가 굴리는 구간과 같아 한 번 재생하면 그 구간을 통째로
       덮는다. 딸깍은 음원이 없을 때의 대체로만 남아 있다(아래 reelRoll 안쪽). */
    /* 릴이 돌아가는 소리. 굴러가는 구간과 길이가 같은 음원이라(실측 2.05초 · MYS_ROLL_MS)
       한 번만 재생하면 그 구간을 그대로 덮는다.
       음원이 없으면 짧은 딸깍을 그 구간 동안 반복해 대신한다 — 한 번의 호출로 끝나야
       부르는 쪽이 음원 유무를 몰라도 되므로, 반복도 여기서 돈다. */
    reelRoll: function(){
      if (playSample('reelroll', 1)) return;
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      for (var i = 0; i < 34; i++) {          // 약 2초 동안 60ms 간격
        noiseBurst(c, t + i * 0.06, 0.012, 0.05, 'highpass', 2600, 2600);
      }
    },
    /* 당첨 금액에서 딱 멈추는 순간. 묵직한 "철컥" + 위로 훑는 화음 + 끝에 남는 반짝임.
       멈춤과 금액 확정이 같은 박자에 와야 "이게 나왔다"로 읽힌다. */
    reelStop: function(){
      if (playSample('reelstop', 1)) return;
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      /* 철컥 — 릴이 물리는 소리. 저역이 있어야 "멈췄다"가 되고, 고역만이면 그냥
         한 번 더 넘어간 것으로 들린다. */
      noiseBurst(c, t, 0.05, 0.16, 'lowpass', 900, 220);
      noiseBurst(c, t, 0.02, 0.10, 'highpass', 3000, 3000);
      // C6 · E6 · G6 · C7 을 40ms 간격으로 훑는다
      [1046.5, 1318.5, 1568.0, 2093.0].forEach(function(hz, i){
        tone(c, hz, t + 0.05 + i * 0.04, 0.30, 0.032, 'triangle');
      });
      tone(c, 2637.0, t + 0.27, 0.55, 0.024, 'sine');   // 끝에 남는 반짝임 (E7)
    },
    /* 바운티를 챙길 때 — 아바타 위로 +N P 가 떠오르는 그 순간.
       음원(0.53초)이 오면 그것을 쓰고, 없으면 아주 짧은 2음 상승으로 대신한다.
       총성과 반대 방향(올라가는 음)이라 "받았다"로 읽힌다. */
    bountyUp: function(){
      if (playSample('bountyearn', 1)) return;
      var c = ac(); if (!c) return;
      var t = c.currentTime;
      tone(c, 1174.7, t, 0.07, 0.030, 'triangle');         // D6
      tone(c, 1567.9, t + 0.055, 0.10, 0.026, 'triangle'); // G6
    },
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

  /* ── 헤더 스피커 · 슬라이더 ──────────────────────────────────────────
     이 파일은 헤더 DOM이 생기기 전에 실행되므로 요소를 붙잡아 두지 않고 전부 위임으로 받는다.
     (예전에 종 버튼을 여기서 붙잡았다가, 파싱 시점에 아직 없어서 통째로 죽은 적이 있다.) */
  function saveSfx(){
    try {
      localStorage.setItem(SFX_KEY, sfxOn ? 'on' : 'off');
      localStorage.setItem(VOL_KEY, String(vol));
    } catch(e){}
  }
  /* 슬라이더와 퍼센트는 "실제로 나가는 크기"를 보여준다 — 음소거인데 손잡이가 70%에
     있으면 화면이 거짓말을 하는 것이다. 대신 vol 은 그대로 두므로, 다시 켜면 70%로 돌아온다. */
  function syncSfxUi(){
    var pct = Math.round(masterLevel() * 100);
    var r = document.getElementById('sfxRange');
    if (r) {
      if (Number(r.value) !== pct) r.value = String(pct);
      // 지나온 만큼 금색으로 채운다 — 손잡이 위치만으로는 한눈에 안 읽힌다.
      // 채움 길이는 값에 따라 달라지므로 CSS가 알 수 없다. 변수로만 넘기고 그리는 건 CSS가 한다.
      r.style.setProperty('--fill', pct + '%');
    }
    var p = document.getElementById('sfxPct');
    if (p) p.textContent = pct + '%';
    var b = document.getElementById('sfxBtn');
    if (b) {
      b.setAttribute('aria-pressed', pct > 0 ? 'false' : 'true');
      b.setAttribute('title', pct > 0 ? '음소거' : '소리 켜기');
    }
  }
  function afterSfxChange(quiet){
    saveSfx(); markSfxState(); applyLevel(); syncSfxUi();
    if (masterLevel() <= 0) return;
    preloadSfx();
    // 바뀐 크기를 귀로 확인할 수 있어야 한다. 슬라이더를 끄는 동안에는 소리를 겹쳐 내지 않는다.
    if (!quiet && window.casinoSfx && window.casinoSfx.chip) window.casinoSfx.chip();
  }

  window.casinoSfxToggle = function(){
    sfxOn = !sfxOn;
    /* 0%인 채로 음소거를 풀면 여전히 아무 소리도 안 난다 — 누른 사람에게는 버튼이 고장 난
       것으로 보인다. 그럴 때만 절반까지 올려 준다. */
    if (sfxOn && vol <= 0) vol = VOL_HALF;
    afterSfxChange(false);
    return sfxOn;
  };
  // 0~1. 인자 없이 부르면 지금 크기를 돌려준다.
  window.casinoVolume = function(v){
    if (v == null) return masterLevel();
    v = Math.min(1, Math.max(0, Number(v) || 0));
    /* 0까지 내리면 음소거로 본다. 반대로 0보다 위로 올리면 음소거가 저절로 풀린다 —
       소리를 키우려고 끝까지 올렸는데 아이콘을 한 번 더 눌러야 한다면 그건 고장으로 읽힌다. */
    sfxOn = v > 0;
    if (v > 0) vol = v;
    afterSfxChange(true);
    return masterLevel();
  };

  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest || !t.closest('#sfxBtn')) return;
    window.casinoSfxToggle();
  });
  document.addEventListener('input', function(e){
    var r = e.target;
    if (!r || r.id !== 'sfxRange') return;
    window.casinoVolume(Number(r.value) / 100);
  });
  /* 슬라이더는 접어 둔다 — 헤더는 자리가 좁고, 음량은 한 번 맞추면 오래 안 건드리는 값이다.
     마우스는 올리면 열린다(CSS). 손가락에는 hover가 없으므로 아이콘을 누른 그 순간에 같이
     연다 — 음소거와 크기 조절을 한 번의 조작 안에서 끝낼 수 있다. */
  document.addEventListener('pointerdown', function(e){
    var w = document.getElementById('sfxWrap');
    if (!w) return;
    w.classList.toggle('open', !!(e.target && e.target.closest && e.target.closest('#sfxWrap')));
  }, true);
  // 서버는 모두에게 같은 머리를 내려보내므로(golden) 저장해 둔 값은 여기서 채운다.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncSfxUi);
  else syncSfxUi();

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
    ANNOUNCEMENT: '📢', ACHIEVEMENT: '🏆', POINT_GIFT: '🎁', SYSTEM: '⚙️',
    TOURNAMENT_OPEN: '♠️', TOURNAMENT_WIN: '👑'
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
        /* 목록에서도 치운다 — 표시만 지우고 남겨 두면 "정리했는데 그대로 있다"가 된다.
           줄 자체는 서버에 남고 "이 사람이 치웠다"만 기록된다. */
        fetch('/api/notifications/dismiss-all', { method: 'POST' }).then(load);
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
  /* ── 시즌 마감 배너 ──────────────────────────────────────────────────
     남은 시간은 서버가 심어 준 초에서 화면이 세어 내려간다. 1초마다 서버에 물으면
     모두가 마감 직전에 초당 한 번씩 요청을 보내는데, 그 시각은 하필 시즌을 넘기는
     순간이다 — 그 요청들이 겹치는 것을 피한다.

     0 이 되면 한 번만 새로 고친다. 그때는 이미 새 시즌이고, 화면의 잔액·랭킹이
     전부 옛 값이라 그대로 두면 사람이 사라진 포인트를 보고 놀란다. */
  var lockTimer = null;
  function lockTick(){
    var bar = document.getElementById('lockBar');
    if (!bar) { if (lockTimer) { clearInterval(lockTimer); lockTimer = null; } return; }
    var left = Math.max(0, Number(bar.getAttribute('data-left')) || 0);
    var el = document.getElementById('lockLeft');
    if (el) {
      var m = Math.floor(left / 60), s = left % 60;
      el.textContent = '남은 시간 ' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    if (left <= 0) {
      clearInterval(lockTimer); lockTimer = null;
      // 넘어간 직후에는 아직 예약이 안 지워졌을 수 있다 — 조금 여유를 두고 새로 고친다
      setTimeout(function(){ location.reload(); }, 2500);
      return;
    }
    bar.setAttribute('data-left', String(left - 1));
  }
  function startLockTick(){
    if (!document.getElementById('lockBar') || lockTimer) return;
    lockTick();
    lockTimer = setInterval(lockTick, 1000);
  }
  /** 서버가 막았을 때 배너가 아직 없으면 그 자리에서 만든다. */
  function showLockBar(secondsLeft){
    if (!document.getElementById('lockBar')) {
      var bar = document.createElement('div');
      bar.className = 'lockbar';
      bar.id = 'lockBar';
      bar.setAttribute('data-left', String(Math.max(0, Number(secondsLeft) || 0)));
      bar.innerHTML = '<b>시즌 마감 정산 중<\/b>'
        + '<span>새 베팅과 보상 수령이 일시 중단되었습니다.<\/span>'
        + '<span class="lockbar-t num" id="lockLeft">남은 시간 --:--<\/span>';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    startLockTick();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startLockTick);
  } else startLockTick();

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
            /* 시즌 마감 락다운 — 서버가 403 으로 막았다.
               게임마다 오류를 어떻게 보여주는지가 달라서(어떤 화면은 조용히 무시한다)
               여기서 한 번에 토스트로 올린다. 그리고 배너를 그 자리에서 붙인다:
               이미 열어 둔 화면은 다시 그려지지 않으므로, 막힌 이 순간이 알려 줄
               유일한 기회다. */
            if (r.status === 403 && ct && ct.indexOf('json') >= 0) {
              r.clone().json().then(function(d){
                if (!d || !d.lockdown) return;
                window.casinoNotify.toast({ type: 'LOCKDOWN', message: d.error || '' });
                showLockBar(d.lockdown.secondsLeft);
              }).catch(function(){ });
            }
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
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    /* 머리 바로 아래에서 시작하게 맞춘다. 고정값으로 두면 헤더에 가려진다 — 헤더는
       sticky 라 스크롤 중에도 화면 위에 있고, 높이도 상황마다 다르다(시즌 마감 배너가
       붙으면 그만큼 높아진다). 토스트를 띄울 때마다 재는 것이 가장 확실하다. */
    var h = document.querySelector('header');
    var top = h ? Math.round(h.getBoundingClientRect().bottom) + 12 : 14;
    stack.style.setProperty('--toast-top', top + 'px');
    return stack;
  }
  /* 종류마다 모양이 다르다. 달성은 금색 트로피에 소리가 나고, 공지는 조용히 뜬다 —
     같은 소리를 내면 "뭔가 해냈다"와 "읽을 것이 있다"가 구분되지 않는다. */
  var TOAST_KIND = {
    ACHIEVEMENT: { cls: 'ach', ic: '🏆', head: '도전과제 달성!', sfx: true },
    ANNOUNCEMENT: { cls: 'noti', ic: '📢', head: '새 공지사항', sfx: false },
    POINT_GIFT: { cls: 'noti', ic: '🎁', head: '포인트', sfx: false },
    SYSTEM: { cls: 'noti', ic: '⚙️', head: '알림', sfx: false },
    /* 등록 시작은 "지금 오라"는 신호라 눈에 띄어야 한다 — 초록 테두리로 공지와 가른다.
       소리는 안 낸다: 다른 게임을 하는 중에 울리면 그 게임의 소리를 덮는다. */
    TOURNAMENT_OPEN: { cls: 'tour', ic: '♠️', head: '홀덤 프리롤 등록 시작', sfx: false },
    TOURNAMENT_WIN: { cls: 'noti', ic: '👑', head: '홀덤 프리롤 우승', sfx: false },
    /* 시즌 마감 락다운 — 기능이 멈췄다는 신호다. 기본값(트로피)으로 두면 막혔다는 말에
       상 받는 그림이 붙어 뜻이 어긋난다. 소리도 안 낸다: 이건 축하가 아니다. */
    LOCKDOWN: { cls: 'warn', ic: '⏳', head: '시즌 마감 정산 중', sfx: false }
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

/* ── 채팅 ────────────────────────────────────────────────────────────────
   카지노 전체가 한 방을 쓴다. 게임마다 방을 나누면 동시 접속이 다섯 명인 서비스에서
   전부 빈 방이 된다 — 어느 화면에 있든 같은 대화가 보이고, 줄마다 그 사람이 어디
   있었는지를 작게 붙여 구분한다.

   ── 폴링을 새로 만들지 않는다
   모든 게임 화면은 이미 1초마다 /state 를 부른다. 채팅용 폴을 하나 더 달면 요청 수가
   정확히 두 배가 된다. 대신 상태 응답에 실린 chatMax(마지막 메시지 id)를 게임 쪽에서
   note() 로 넘겨주고, 그 값이 내가 가진 것보다 클 때만 /api/chat 을 한 번 부른다.
   아무도 말하지 않으면 요청이 한 건도 늘지 않는다.

   폴링이 없는 화면(로비·랭킹·공지)에서는 열려 있는 동안에만 스스로 5초 폴을 돈다.
   닫으면 멈춘다 — 안 보는 화면을 위해 서버를 부를 이유가 없다.

   여기(app.js)에 두는 이유: 게임마다 인라인 스크립트가 따로 있는데 채팅을 거기 넣으면
   같은 코드가 여섯 벌이 된다. 모든 페이지가 이 파일을 받으므로 한 벌이면 된다. */
(function(){
  /* 서버(src/db/queries/chat.ts)의 CHAT_MAX_LEN · CHAT_MIN_GAP_MS 와 같은 값이어야 한다.
     화면 쪽 값은 편의일 뿐이고 마지막 문은 언제나 서버지만, 두 값이 어긋나면 눌리는데
     거절당하거나(화면이 느슨) 보낼 수 있는데 안 눌린다(화면이 빡빡).
     감사(scripts/audit-chat.ts)가 두 값이 같은지 본다. */
  var MAX_LEN = 100;
  var MIN_GAP_MS = 400;
  var MAX_ROWS = 120;            // 화면에 남기는 줄 수. seen 도 이 수에 묶인다
  var IDLE_POLL_MS = 5000;       // 폴링이 없는 화면에서, 열려 있을 때만
  /* 방금 한 말로 볼 시간. 이 안에 들어온 줄만 구독자에게 넘긴다(홀덤 말풍선이 쓴다).
     처음 열 때 받는 40줄과, 탭을 한참 덮어 뒀다가 돌아왔을 때 한꺼번에 들어오는
     묶음이 전부 말풍선으로 터지는 것을 막는다. */
  var LIVE_MS = 15000;
  /* 로비와 도전과제에 적히는 이름 그대로다. 한 게임을 화면마다 다르게 부르면
     "포커"가 홀덤을 가리키는 줄 안다 — 이 카지노에는 포커가 둘이다. */
  var WHERE = { holdem: '홀덤', baccarat: '바카라', blackjack: '블랙잭',
    crash: '그래프', ladder: '사다리', poker: '포커 플립', mines: '지뢰찾기' };

  var open = false, lastId = 0, unread = 0, muteUntil = 0, sendLockUntil = 0;
  /* 마지막으로 눈으로 본 줄. 화면을 옮길 때마다 lastId 가 0 에서 다시 시작하므로
     이것이 없으면 받아 온 최근 40줄이 전부 "안 읽음"으로 잡힌다 — 어느 화면을 열든
     배지에 40 가까운 숫자가 붙어 있어서 그 숫자가 아무 뜻도 없게 된다. */
  var lastSeen = Number(stored('od_chat_seen', '0')) || 0;
  var idleTimer = null, dock = null, listEl = null, inputEl = null, badgeEl = null, noteEl = null;
  var lastEl = null;             // 접힌 바에 뜨는 마지막 한 줄
  var seen = {};                 // id → 1. 같은 줄을 두 번 그리지 않는다
  var subs = [], primed = false; // 첫 수신(과거 줄)에는 구독자를 부르지 않는다
  var jumpBottom = false;        // 방금 펼쳤다 — 다음 수신은 무조건 맨 아래로
  /* 운영자가 가린 줄 수. null 은 "아직 모른다"라서 첫 수신에서는 다시 받지 않는다.
     이 값이 달라지면 목록을 통째로 다시 받는다 — 숨김·되돌리기를 알 다른 방법이 없다. */
  var lastMod = null, needRebuild = false;

  function esc(s){
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hhmm(ms){
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function stored(k, d){ try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function store(k, v){ try { localStorage.setItem(k, v); } catch (e) { } }

  function build(){
    if (dock) return;
    dock = document.createElement('div');
    dock.className = 'chat-dock';
    dock.innerHTML =
      /* 접힌 상태는 알약이 아니라 한 줄 바다. 알약은 "채팅이 있다"만 말했고, 그러면
         열어 보기 전까지 방이 살아 있는지 알 수 없다 — 동시 접속이 다섯인 방에서 그건
         아무도 안 열고 아무도 안 쓰는 쪽으로 굴러간다.
         마지막 줄을 그 자리에 그대로 띄우면, 접힌 채로도 대화가 보인다. */
      '<button type="button" class="chat-tab" aria-label="채팅 열기">'
        + '<i class="chat-ico" aria-hidden="true">💬</i>'
        + '<span class="chat-last"><span class="chat-last-e">채팅</span></span>'
        + '<i class="chat-badge" hidden></i>'
      + '</button>'
      + '<div class="chat-panel" hidden>'
        + '<div class="chat-head"><b>채팅</b>'
          + '<span class="chat-note"></span>'
          /* 닫기가 아니라 최소화다 — 누르면 대화가 사라지는 것이 아니라 접힐 뿐이고,
             받아 둔 줄과 안 읽은 수는 그대로 남는다. ×로 그리면 "나가기"로 읽힌다. */
          + '<button type="button" class="chat-min" title="최소화" aria-label="최소화">−</button>'
        + '</div>'
        + '<div class="chat-list"></div>'
        + '<div class="chat-foot">'
          + '<input type="text" class="chat-in" maxlength="' + MAX_LEN + '" placeholder="메시지를 입력하세요">'
          + '<button type="button" class="chat-send">보내기</button>'
        + '</div>'
      + '</div>';
    document.body.appendChild(dock);
    listEl = dock.querySelector('.chat-list');
    lastEl = dock.querySelector('.chat-last');
    inputEl = dock.querySelector('.chat-in');
    badgeEl = dock.querySelector('.chat-badge');
    noteEl = dock.querySelector('.chat-note');
    dock.querySelector('.chat-tab').addEventListener('click', function(){ toggle(); });
    dock.querySelector('.chat-min').addEventListener('click', function(){ toggle(false); });
    dock.querySelector('.chat-send').addEventListener('click', send);
    inputEl.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      /* 입력 중에 Esc — 마우스를 옮기지 않고 접는다. 게임 화면에서는 채팅을 치다가
         곧바로 액션 버튼으로 돌아가야 하는 순간이 온다. */
      else if (e.key === 'Escape') { e.preventDefault(); toggle(false); }
    });
    syncWidth();
    window.addEventListener('resize', syncWidth);
    /* 우측 패널은 처음부터 화면에 있는 것이 아니다 — 홀덤은 로비를 보다가 테이블이
       열릴 때 비로소 크기가 생긴다. 크기가 생기는 순간을 직접 듣는다. */
    var side = document.querySelector('.game-side');
    if (side && typeof ResizeObserver === 'function') {
      try { new ResizeObserver(syncWidth).observe(side); } catch (e) { }
    }
  }

  /* ── 우측 패널에 폭을 맞춘다 ────────────────────────────────────────
     도크는 position:fixed 라 화면 오른쪽을 기준으로 뜬다. 그런데 게임 화면의 오른쪽
     끝은 화면 끝이 아니라 우측 패널(참가인원/랭킹)의 오른쪽 모서리다. 폭도 게임마다
     다르다(290px, 좁은 창에서는 240px). 고정 폭으로 띄우면 그 차이만큼 왼쪽으로
     비어져 나와 베팅 컨트롤을 덮는다 — 실제로 그랬다.

     그래서 패널을 실측해서 폭과 오른쪽 여백을 그대로 가져온다. 계산이 아니라 실측인
     이유는, 계산하려면 main 의 max-width·padding·게임별 폭을 여기서 다시 알아야 하고
     그 값들이 바뀌면 여기가 조용히 틀리기 때문이다. */
  function syncWidth(){
    if (!dock) return;
    var side = document.querySelector('.game-side');
    var ok = false;
    if (side && side.offsetParent !== null) {
      var r = side.getBoundingClientRect();
      var vw = document.documentElement.clientWidth || window.innerWidth;
      /* 좁은 창에서는 패널이 본문 아래로 내려가 폭이 화면 전체가 된다. 그 폭을
         따라가면 채팅이 화면을 통째로 덮는다 — 그때는 기본 배치로 돌아간다. */
      if (r.width >= 200 && r.width <= vw * 0.6) {
        dock.style.right = Math.max(8, Math.round(vw - r.right)) + 'px';
        dock.style.setProperty('--chat-w', Math.round(r.width) + 'px');
        ok = true;
      }
    }
    dock.classList.toggle('sync', ok);
    /* 인라인 값은 미디어 쿼리를 이긴다. 맞출 수 없는 상황이면 반드시 지워야
       좁은 화면 규칙이 되살아난다. */
    if (!ok) { dock.style.right = ''; dock.style.removeProperty('--chat-w'); }
  }

  function toggle(want){
    open = want === undefined ? !open : !!want;
    dock.querySelector('.chat-panel').hidden = !open;
    dock.classList.toggle('on', open);
    store('od_chat_open', open ? '1' : '0');
    if (open) {
      syncWidth();                             // 접혀 있는 동안 창이 바뀌었을 수 있다
      markSeen(); unread = 0; paintBadge();
      /* 펼치면 무조건 맨 아래 — 방금 오간 말이 먼저 보여야 한다.
         읽던 자리로 되돌려 주는 것이 친절해 보이지만, 이 방은 지나간 기록을 훑는 곳이
         아니라 지금 오가는 대화에 끼어드는 곳이다. 접혀 있는 동안에는 목록이
         display:none 이라 높이가 0 이었고, 그래서 "아래에 붙어 있었나" 판정도 무의미하다. */
      jumpBottom = true;
      toBottom();                              // 이미 받아 둔 줄은 지금 바로 내린다
      pull();                                  // 그 사이 들어온 줄도 받아 온다
      if (inputEl) inputEl.focus();
      startIdle();
    } else {
      stopIdle();
    }
  }

  /* 폴링이 없는 화면을 위한 느린 폴. 열려 있을 때만 돈다.
     게임 화면에서는 note() 가 대신 깨우므로 이 타이머가 있어도 헛돌지 않는다 —
     서로 같은 pull() 을 부르고, pull 은 새 줄이 없으면 그리지 않는다. */
  function startIdle(){
    if (idleTimer) return;
    idleTimer = setInterval(function(){
      if (document.hidden) return;
      pull();
    }, IDLE_POLL_MS);
  }
  function stopIdle(){ if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } }

  /* 여기까지 봤다고 적어 둔다. 화면을 옮겨도 남아야 하므로 localStorage 다 —
     펼쳐 놓고 있는 동안에도 새 줄이 올 때마다 갱신한다. */
  function markSeen(){
    if (lastId <= lastSeen) return;
    lastSeen = lastId;
    store('od_chat_seen', String(lastSeen));
  }

  /* 목록을 맨 아래로. scrollHeight 를 읽는 순간 레이아웃이 확정되므로, 방금 감춤을
     푼 직후에 불러도 제대로 된 높이가 나온다. */
  function toBottom(){ if (listEl) listEl.scrollTop = listEl.scrollHeight; }

  /* 접힌 바에 마지막 한 줄을 그린다. 펼쳐 있으면 바가 숨어 있으므로 그려도 보이지
     않지만, 그때도 갱신해 둔다 — 접는 순간 옛 줄이 보이면 안 된다. */
  function paintLast(m, fresh){
    if (!lastEl || !m) return;
    var t = TOP[m.rank];
    lastEl.className = 'chat-last' + (t ? ' ' + t[0] : '');
    lastEl.innerHTML = (t ? '<i class="chat-md" aria-hidden="true">' + t[1] + '</i>' : '')
      + '<span class="chat-nm">' + esc(m.name) + '</span>'
      + '<span class="chat-b">' + esc(m.body) + '</span>';
    /* 새로 온 줄일 때만 슬쩍 올라온다. 처음 받아 온 지난 대화까지 움직이면
       "방금 누가 말했다"는 신호가 값싸진다. */
    if (!fresh) return;
    lastEl.classList.remove('up');
    void lastEl.offsetWidth;
    lastEl.classList.add('up');
  }

  function paintBadge(){
    if (!badgeEl) return;
    badgeEl.hidden = unread <= 0;
    badgeEl.textContent = unread > 99 ? '99+' : String(unread);
    /* 접혀 있을 때만 깜빡인다. 열어 놓고 보는 중에는 안 읽은 수가 0이라 어차피
       숨지만, 조건을 열림에도 걸어 두면 나중에 배지를 다른 데 쓸 때 조용히 깜빡인다. */
    badgeEl.classList.toggle('blink', !open && unread > 0);
  }

  function paintNote(){
    if (!noteEl) return;
    var left = Math.max(0, muteUntil - Date.now());
    if (left > 0) {
      noteEl.textContent = '채팅 제한 ' + Math.ceil(left / 1000) + '초';
      if (inputEl) { inputEl.disabled = true; inputEl.placeholder = '지금은 보낼 수 없습니다'; }
    } else {
      noteEl.textContent = '';
      if (inputEl) { inputEl.disabled = false; inputEl.placeholder = '메시지를 입력하세요'; }
    }
  }

  /* 상위 세 사람은 메달과 이름 색으로 표가 난다.
     한때 [👑 #1] 처럼 순위를 글자로 적었는데, 240~290px 짜리 창에서 그 네 글자가
     이름과 게임 태그를 밀어내 정작 한 말이 네 번째 조각이 됐다. 메달은 글리프 하나이고
     등수를 읽지 않아도 색과 모양으로 안다.
     4위 이하는 메달이 없다 — 있는 것과 없는 것의 차이가 곧 정보다. */
  var TOP = { 1: ['t1', '🥇'], 2: ['t2', '🥈'], 3: ['t3', '🥉'] };

  function add(m){
    if (seen[m.id]) return;
    seen[m.id] = 1;
    var mine = m.userId === window.__MEID__;
    var w = m.where && WHERE[m.where] ? '<i class="chat-w">' + esc(WHERE[m.where]) + '</i>' : '';
    var t = TOP[m.rank];
    var row = document.createElement('div');
    row.className = 'chat-row' + (mine ? ' me' : '') + (t ? ' ' + t[0] : '');
    /* 메달 · 이름 · 어디 · 말. 이름표와 말 사이에 콜론 하나를 둔다 — 게임 태그까지 붙으면
       어디까지가 이름표고 어디부터가 한 말인지 눈이 한 번 더듬는다. */
    row.innerHTML = (t ? '<i class="chat-md" aria-hidden="true">' + t[1] + '</i>' : '')
      + '<span class="chat-nm" title="' + esc(hhmm(m.at)) + '">' + esc(m.name) + '</span>'
      + w + '<span class="chat-c">:</span>'
      + '<span class="chat-b">' + esc(m.body) + '</span>';
    row.dataset.id = m.id;
    listEl.appendChild(row);
    /* 보관은 화면에서도 잘라 둔다 — 오래 켜 두면 DOM 이 계속 자란다.
       걷어낸 줄은 seen 에서도 지운다. 예전에는 DOM 만 잘라서, 탭을 하루 종일 열어 두면
       본 적 있는 id 가 끝없이 쌓였다 — 한 줄에 키 하나씩이라 눈에 띄는 양은 아니지만
       상한이 없는 것은 그 자체로 새는 것이다.
       지운 id 가 다시 올 걱정은 없다: 서버는 since 보다 큰 id 만 준다. */
    while (listEl.childElementCount > MAX_ROWS) {
      var gone = listEl.firstChild;
      delete seen[gone.dataset.id];
      listEl.removeChild(gone);
    }
  }

  /* ── 가려진 줄을 걷어낸다 ────────────────────────────────────────────
     운영자가 줄을 가려도 화면은 그것을 알 방법이 없었다. 받아 오는 것은 "내가 가진
     마지막 id 뒤의 새 줄"뿐이라, 이미 그려 둔 줄이 없어졌다는 신호가 오지 않는다.
     게다가 chatMax(마지막 id)는 숨김으로 바뀌지 않아서 재요청조차 하지 않았다 —
     가린 사람 화면에서만 사라지고 남들에게는 그대로 보였다.

     그래서 서버가 "가려진 줄 수"(mod)를 함께 준다. 그 값이 달라지면 목록을 통째로
     다시 받는다. 숨김과 되돌리기가 한 경로로 처리되고(되돌린 줄은 다시 그려야 하는데
     since 로는 영영 못 받는다), 조치는 드물게 일어나므로 비용도 그때뿐이다. */
  function rebuild(){
    lastId = 0;
    seen = {};
    if (listEl) listEl.innerHTML = '';
    /* 다시 채우는 동안은 "처음 여는 것"으로 취급한다 — 안 그러면 되받은 지난 줄이
       전부 새 말인 양 홀덤 말풍선으로 터지고, 접힌 바도 매번 새로 튀어 오른다. */
    primed = false;
    pull();
  }

  var pulling = false;
  function pull(){
    if (pulling) return;
    pulling = true;
    fetch('/api/chat?since=' + lastId)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d || !d.messages) return;
        /* 응답으로도 조치를 알아챈다 — 느린 폴로 도는 화면(로비·랭킹)은 게임 상태를
           받지 않아서 이 경로가 유일한 신호다. 지금 요청 중이라 여기서 바로 다시
           부를 수는 없고, 아래 마무리에서 한 번 다시 받는다. */
        if (typeof d.mod === 'number') {
          if (lastMod !== null && d.mod !== lastMod) needRebuild = true;
          lastMod = d.mod;
        }
        if (typeof d.muteLeftMs === 'number') {
          muteUntil = d.muteLeftMs > 0 ? Date.now() + d.muteLeftMs : 0;
          paintNote();
        }
        var atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 24;
        var added = 0, live = [];
        d.messages.forEach(function(m){
          if (m.id > lastId) lastId = m.id;
          if (seen[m.id]) return;
          add(m); added++;
          if (!open && m.id > lastSeen && m.userId !== window.__MEID__) unread++;
          if (primed) live.push(m);
        });
        if (open) markSeen();
        if (added) paintBadge();
        /* 접힌 바에는 언제나 가장 마지막 줄이 뜬다. 목록은 오름차순이라 끝이 최신이다. */
        if (d.messages.length) paintLast(d.messages[d.messages.length - 1], primed);
        /* 방금 펼쳤으면 무조건 내린다. 그 밖에는 아래에 붙어 있던 사람만 따라 내린다 —
           위를 읽는 중인데 끌어내리면 읽던 자리를 잃는다. */
        if (jumpBottom || (added && atBottom)) toBottom();
        jumpBottom = false;
        /* 구독자(홀덤 말풍선)는 첫 수신을 건너뛴다 — 처음 열 때 받는 것은 지난
           대화지 방금 한 말이 아니다. */
        live.forEach(fire);
        primed = true;
      })
      .catch(function(){ /* 일시적 실패는 다음 기회에 회복된다 */ })
      .then(function(){
        pulling = false;
        /* 조치가 있었으면 여기서 한 번만 다시 받는다. rebuild 안에서 부르는 pull 은
           mod 가 이미 최신이라 needRebuild 를 다시 세우지 않는다 — 무한히 돌지 않는다. */
        if (needRebuild) { needRebuild = false; rebuild(); }
      });
  }

  function flash(msg){
    if (!noteEl) return;
    noteEl.textContent = msg;
    setTimeout(paintNote, 2200);
  }

  function send(){
    if (!inputEl) return;
    var body = inputEl.value.trim();
    if (!body) return;
    if (Date.now() < sendLockUntil) return;
    /* 화면에서도 잠근다 — 서버가 막아 주지만, 눌리는데 아무 일도 안 나면 고장으로 읽힌다. */
    sendLockUntil = Date.now() + MIN_GAP_MS;
    inputEl.value = '';
    fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: body, where: window.__CHAT_WHERE__ || null }) })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(r){
        if (!r.ok) {
          flash(r.d && r.d.error ? r.d.error : '보낼 수 없습니다');
          if (r.d && r.d.leftMs) {
            sendLockUntil = Date.now() + r.d.leftMs;
            /* 재갈이면 남은 시간을 그대로 반영한다 — 입력창이 계속 열려 있으면
               보낼 때마다 거절당하는 것을 그때 알게 된다. */
            if (r.d.error && r.d.error.indexOf('제한') >= 0) {
              muteUntil = Date.now() + r.d.leftMs; paintNote();
            }
          }
          inputEl.value = body;               // 쓴 말을 잃지 않게 되돌린다
          return;
        }
        pull();
      })
      .catch(function(){ flash('전송 실패'); inputEl.value = body; });
  }

  /* 게임 화면이 폴링 응답을 받을 때마다 부른다. 값이 움직였을 때만 실제로 요청한다.
     새 줄(max)뿐 아니라 운영자 조치(mod)도 본다 — 숨김은 max 를 바꾸지 않아서,
     이것이 없으면 가려진 줄이 남의 화면에 그대로 남는다(실제로 그랬다). */
  function note(max, mod){
    if (typeof mod === 'number' && lastMod !== null && mod !== lastMod) {
      lastMod = mod;
      rebuild();
      return;                    // rebuild 가 어차피 최신까지 받아 온다
    }
    if (typeof mod === 'number' && lastMod === null) lastMod = mod;
    if (typeof max !== 'number' || max <= lastId) return;
    pull();
  }

  /* 방금 들어온 줄을 게임 화면에 넘긴다(홀덤 테이블 말풍선).
     구독자가 던지는 예외로 채팅이 멈추면 안 된다 — 채팅은 여기서 끝이고,
     말풍선은 곁다리다. */
  function fire(m){
    if (Date.now() - (m.at || 0) > LIVE_MS) return;
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](m); } catch (e) { }
    }
  }
  function onMessage(fn){ if (typeof fn === 'function') subs.push(fn); }

  function init(){
    if (!window.__MEID__) return;             // 로그인 안 한 화면에는 붙이지 않는다
    build();
    lastId = 0;
    pull();                                   // 최근 줄을 한 번 받아 배지를 세운다
    if (stored('od_chat_open', '0') === '1') toggle(true);
    else paintBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.casinoChat = { note: note, open: function(){ toggle(true); }, onMessage: onMessage };
})();
