/* 서버가 스스로 판을 전진시킨다.
 *
 * ── 왜 필요한가
 * 이 서비스의 게임은 전부 지연 진행이다 — 판을 넘기는 것은 타이머가 아니라 누군가의
 * 요청이었다(handleState 가 advanceXxx 를 부른다). 그래서 아무도 그 게임 화면을 안 보고
 * 있으면 라운드가 그 자리에 선다. 접속자가 스무 명이어도, 그래프 화면을 연 사람이
 * 하나도 없으면 그래프는 멈춘다.
 *
 * 화면 쪽은 3분 쉬면 폴링을 끄고(IDLE_MS), 탭을 덮어도 끈다. 그건 배터리를 아끼는
 * 옳은 동작인데, 진행을 그 폴링에 맡겨 두는 바람에 "쉬면 게임이 선다"가 따라왔다.
 * 폰에서는 더 심해진다 — 화면을 끄면 브라우저가 알아서 멈춘다.
 *
 * ── 무엇을 바꾸지 않는가
 * 요청 경로는 손대지 않는다. handleState 는 지금처럼 advanceXxx 를 계속 부른다.
 * 그래서 이 타이머가 어떤 이유로든 죽어도 예전 동작이 그대로 남는다 — 이 파일은
 * 대체가 아니라 덧붙임이고, index.ts 에서 한 줄을 빼면 정확히 지금으로 돌아간다.
 *
 * ── 겹쳐 불려도 되는 이유
 * 전진 함수들은 원래부터 "지금 시각 기준으로 밀린 일을 전부 처리"하도록 짜여 있고,
 * 상태 전이는 `UPDATE ... WHERE id = ? AND phase = 'betting'` 처럼 조건부라 두 번
 * 불려도 두 번 전진하지 않는다. 게다가 node:sqlite 는 동기이고 Node 는 단일 스레드라,
 * 한 프로세스 안에서 타이머와 요청이 서로의 트랜잭션 사이에 끼어들 수 없다.
 *   (머신을 둘 이상으로 늘리는 날에는 이 전제가 깨진다. 그때는 볼륨이 한 머신에만
 *    붙는다는 제약부터 다시 봐야 하므로, 이 파일만의 문제가 아니다.)
 *
 * ── 절전
 * 예전에는 "접속이 없으면 7분 뒤 절전"이라 타이머를 걸 수 없었다. 지금은 fly.toml 이
 * auto_stop_machines = "off" 라 상시 가동이므로 그 제약이 없다. 상시 가동 비용은
 * 이미 내고 있고(월 $2.02), 운영 CPU 는 0.2% 만 쓰고 있었다.
 */
/* 게임마다 전진 함수 하나씩만 가져온다. 그 안에서 어떤 규칙과 헬퍼를 쓰는지는
   그 모듈이 쥔다 — 여기서 헬퍼를 조립하면 규칙이 두 곳에 생기고, 화면이 부르는
   전진과 타이머가 부르는 전진이 언젠가 달라진다. */
import { advanceHoldem } from './db/holdem';
import { advance as advanceCrash } from './web/games/crash';
import { advance as advanceLadder } from './web/games/ladder';
import { advance as advancePoker } from './web/games/poker';

interface Job {
  name: string;
  /** 이 간격으로 부른다(ms). 화면이 그 게임을 보는 주기와 맞춘다. */
  everyMs: number;
  run: () => void;
}

/* 그래프만 250ms 다. 라운드가 도는 동안 배율이 실시간으로 오르고 자동 캐시아웃이
   그 위에서 확정되기 때문이다 — 화면도 그 구간에서는 250ms 로 본다.
   나머지는 1초면 충분하다. 사람이 느끼는 단위가 초이고, 더 잘게 돌아 봐야
   같은 일을 여러 번 확인할 뿐이다. */
const JOBS: Job[] = [
  { name: 'crash', everyMs: 250, run: () => void advanceCrash() },
  { name: 'ladder', everyMs: 1000, run: () => void advanceLadder() },
  { name: 'poker', everyMs: 1000, run: () => void advancePoker() },
  /* 홀덤은 대회가 없을 때도 부른다. 안에서 "열린 대회가 있나"를 먼저 보고 없으면 곧
     돌아오므로 값이 싸고, 자동 개최(ensureRecurring)도 이 경로를 탄다 — 예약해 둔
     대회가 열리는 것도 지금은 누군가 화면을 봐야 일어난다. */
  { name: 'holdem', everyMs: 1000, run: () => void advanceHoldem() },
];

/* 연달아 실패하면 간격을 늘린다. 무엇이 고장 났든 1초에 한 번씩 같은 예외를 찍어
   로그를 덮는 것이 가장 나쁘다 — 고장을 못 보게 만든다.
   성공하면 즉시 원래 간격으로 돌아온다. */
const BACKOFF_AFTER = 3;
const BACKOFF_MAX_MS = 60_000;

const timers: NodeJS.Timeout[] = [];
let running = false;

function schedule(job: Job, delayMs: number, fails: number): void {
  const t = setTimeout(() => {
    let nextFails = fails;
    try {
      job.run();
      nextFails = 0;
    } catch (e) {
      nextFails = fails + 1;
      /* 처음 몇 번만 찍는다. 그 뒤로는 간격이 벌어지므로 저절로 뜸해진다. */
      if (nextFails <= BACKOFF_AFTER) console.error(`[tick:${job.name}] 전진 실패:`, e);
      else if (nextFails === BACKOFF_AFTER + 1) {
        console.error(`[tick:${job.name}] 계속 실패해서 간격을 늘린다`);
      }
    }
    if (!running) return;
    const back = nextFails > BACKOFF_AFTER
      ? Math.min(BACKOFF_MAX_MS, job.everyMs * 2 ** (nextFails - BACKOFF_AFTER))
      : job.everyMs;
    schedule(job, back, nextFails);
  }, delayMs);
  /* 이 타이머가 프로세스를 붙들지 않게 한다 — 붙들면 종료 신호를 받고도 안 죽는다.
     서버 소켓이 이미 프로세스를 살려 두므로 여기서 붙들 이유가 없다. */
  t.unref?.();
  timers.push(t);
}

/**
 * 전진 타이머를 시작한다. 서버가 뜰 때 한 번 부른다.
 *
 * setInterval 이 아니라 "끝나면 다음을 예약"하는 방식이다 — 한 번의 전진이 간격보다
 * 오래 걸려도 호출이 쌓이지 않는다. 사람이 늘어 DB 가 느려질 때 그 차이가 난다.
 */
export function startTicks(): void {
  if (running) return;
  /* 되돌릴 구멍을 하나 둔다. 배포한 뒤 무언가 이상하면 코드를 고치지 않고
     TICK=off 로 끌 수 있다 — 그때는 예전(요청이 전진시키는) 동작으로 돌아간다. */
  if (process.env.TICK === 'off') {
    console.log('[tick] TICK=off — 서버 전진을 켜지 않는다 (요청이 전진시킨다)');
    return;
  }
  running = true;
  /* 시작을 조금씩 어긋나게 둔다. 네 개가 같은 밀리초에 깨어나면 그 순간에만 부하가
     몰리고, DB 는 어차피 한 번에 하나씩 처리하므로 서로 기다리게 된다. */
  JOBS.forEach((job, i) => schedule(job, 200 + i * 60, 0));
  console.log(`[tick] 서버 전진 시작 — ${JOBS.map(j => `${j.name} ${j.everyMs}ms`).join(' · ')}`);
}

/** 멈춘다. 감사에서 쓴다 — 검사 하나가 타이머를 남기면 다음 검사가 그 위에서 돈다. */
export function stopTicks(): void {
  running = false;
  while (timers.length) clearTimeout(timers.pop()!);
}
