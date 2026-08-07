import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'path';
import { env } from '../env';

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    // DB_PATH는 파일이 아니라 디렉터리다. 없으면 sqlite가 "unable to open database file"로
    // 기동 즉시 죽어버리므로(원인이 드러나지 않는 에러다) 직접 만들어 준다.
    const dbDir = env('DB_PATH') || process.cwd();
    mkdirSync(dbDir, { recursive: true });
    db = new DatabaseSync(path.join(dbDir, 'data.db'));
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_date TEXT,
      role TEXT DEFAULT 'member',
      created_at INTEGER DEFAULT (unixepoch()),
      last_active INTEGER DEFAULT 0
    );

    -- 디스코드 채널에 고정해 두는 버튼 메시지(출석판·지원금판)의 위치.
    -- 신청 로그가 쌓이면 버튼이 위로 밀려 올라가므로, 로그를 남길 때마다 이전 메시지를 지우고
    -- 맨 아래에 다시 올린다. 그러려면 어떤 메시지를 지워야 하는지 기억해야 한다.
    CREATE TABLE IF NOT EXISTS discord_boards (
      kind TEXT PRIMARY KEY,        -- 'attendance' | 'relief'
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- 웹 세션 (재시작에도 유지)
    CREATE TABLE IF NOT EXISTS web_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    -- 포인트 증감 감사 로그 (출석/보너스/게임 결과 전부 여기 기록)
    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id, created_at);

    -- 게임 공통 라운드 테이블 (지뢰찾기/사다리/그래프/바카라/블랙잭 공용)
    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      game_type TEXT NOT NULL,
      bet_amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      state_json TEXT NOT NULL,
      payout INTEGER,
      multiplier REAL,
      created_at INTEGER DEFAULT (unixepoch()),
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_user_status ON game_rounds(user_id, status);

    -- 사다리게임: 여러 유저가 같은 라운드에 함께 베팅하는 실시간 공용 라운드 (지뢰찾기와 달리 1인 1라운드가 아님)
    CREATE TABLE IF NOT EXISTS ladder_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'done'
      betting_ends_at INTEGER NOT NULL,
      start_side TEXT,
      end_side TEXT,
      rungs_json TEXT,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS ladder_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      start_guess TEXT,   -- 'L' | 'R' (출발 좌/우)
      parity_guess TEXT,  -- 'ODD' | 'EVEN' (가로줄 개수의 홀짝)
      amount INTEGER NOT NULL,
      won INTEGER,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_ladder_bets_round ON ladder_bets(round_id);

    -- 그래프게임(크래시): 사다리처럼 여러 유저가 같은 라운드에 함께 베팅하고, 각자 원하는 시점에 캐시아웃한다.
    -- crash_point는 라운드 생성 시 미리 정해두되 크래시 이후에만 공개한다(진행 중엔 절대 클라이언트로 내리지 않음).
    CREATE TABLE IF NOT EXISTS crash_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'running' | 'done'
      betting_ends_at INTEGER NOT NULL,      -- 초 단위
      started_at_ms INTEGER,                 -- 상승 시작 시각(ms) — 배율 계산 기준
      crash_point REAL NOT NULL,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS crash_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      amount INTEGER NOT NULL,
      auto_cashout REAL,                     -- 자동 캐시아웃 목표 배율 (NULL이면 수동)
      cashout_multiplier REAL,               -- NULL이면 아직 캐시아웃 안 함
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_crash_bets_round ON crash_bets(round_id);

    -- 포커 플립: 홀카드 2장씩 공개 후 승자/등급 시장에 베팅, 플롭→턴→리버 순차 공개.
    -- 보드 5장은 라운드 생성 시 미리 정해두고 시간에 따라 공개 범위만 넓힌다(공개 전엔 절대 내려보내지 않음).
    CREATE TABLE IF NOT EXISTS poker_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'flop' | 'turn' | 'river' | 'done'
      betting_ends_at INTEGER NOT NULL,      -- 초
      hole_json TEXT NOT NULL,               -- [master0, master1, shark0, shark1]
      board_json TEXT NOT NULL,              -- [b0..b4]
      odds_json TEXT NOT NULL,               -- 시장별 확률/배당 (배당 null = 비활성 시장)
      result_json TEXT,                      -- 정산 결과 (승자, 양쪽 등급 등)
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS poker_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      market TEXT NOT NULL,                  -- 'master'|'shark'|'tie'|'b0'..'b4'
      amount INTEGER NOT NULL,
      odds REAL NOT NULL,                    -- 베팅 시점 배당 고정
      won INTEGER,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    -- 칩을 쌓는 방식이라 같은 시장에 여러 번 베팅하면 한 행의 amount가 누적된다
    CREATE UNIQUE INDEX IF NOT EXISTS idx_poker_bets_unique ON poker_bets(round_id, user_id, market);
    CREATE INDEX IF NOT EXISTS idx_poker_bets_round ON poker_bets(round_id);

    -- 바카라: 포커 플립과 같은 "다 같이 한 라운드" 구조지만 배당은 매 라운드 같다.
    -- 바카라에는 플레이어가 내리는 선택이 없어(드로우가 규칙 표로 고정) 확률이 항상 동일하기 때문이다.
    -- 카드는 라운드 생성 시 6장(최대치)을 미리 뽑아두고 시간에 따라 공개 범위만 넓힌다.
    CREATE TABLE IF NOT EXISTS baccarat_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting' | 'deal' | 'third' | 'reveal' | 'done'
      betting_ends_at INTEGER NOT NULL,      -- 초
      cards_json TEXT NOT NULL,              -- 뽑아둔 6장 (P1,B1,P2,B2,P3,B3 순서로 소비)
      result_json TEXT,                      -- 정산 결과 (승자·양쪽 끗수·페어 등)
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS baccarat_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      market TEXT NOT NULL,                  -- 'player'|'banker'|'tie'|'ppair'|'bpair'
      amount INTEGER NOT NULL,
      odds REAL NOT NULL,                    -- 베팅 시점 배당 고정
      won INTEGER,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_baccarat_bets_unique ON baccarat_bets(round_id, user_id, market);
    CREATE INDEX IF NOT EXISTS idx_baccarat_bets_round ON baccarat_bets(round_id);

    -- 블랙잭: 7석 공용 테이블. 결정은 전원이 같은 창에서 동시에 한다.
    -- 카드를 몇 장 쓸지 미리 알 수 없어(각자 원하는 만큼 힛한다) 슈를 통째로 섞어 저장하고
    -- 커서(shoe_pos)를 밀며 꺼내 쓴다. shoe_json에는 앞으로 나올 카드가 전부 들어 있으므로
    -- 절대 클라이언트로 내려보내면 안 된다 — 한 장이 아니라 남은 판 전체가 새는 셈이다.
    CREATE TABLE IF NOT EXISTS blackjack_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL DEFAULT 'betting', -- 'betting'|'deal'|'action'|'dealer'|'done'
      -- 아무도 앉지 않았으면 NULL이다. 빈 테이블에서 카드가 계속 돌면 볼 사람도 없이
      -- 슈만 축나고, 들어온 사람은 남의 라운드 끝나기를 기다려야 한다.
      -- 첫 사람이 앉는 순간 값이 채워지고 그때부터 카운트다운이 시작된다.
      betting_ends_at INTEGER,               -- 초
      -- 모두가 결정을 마치면 15초를 다 기다리지 않고 여기에 끝난 시각을 적어 바로 넘어간다
      action_ended_at INTEGER,
      shoe_json TEXT NOT NULL,
      shoe_pos INTEGER NOT NULL DEFAULT 0,
      dealer_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS blackjack_hands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,                 -- 0~6
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      bet INTEGER NOT NULL,
      cards_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'playing', -- 'playing'|'stand'|'bust'|'blackjack'
      outcome TEXT,
      payout INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    /* 한 사람은 한 자리만, 한 자리에는 한 사람만.
       이 두 유니크 인덱스가 "한 사람 = 한 손패"를 보장한다 — 스플릿을 넣지 않기로 한
       결정이 여기에 박혀 있다. 스플릿을 하려면 손패가 사람당 여러 개가 되어야 해서
       이 인덱스부터 정산 루프·액션 API·자리 UI까지 전제가 전부 깨진다.
       (기본 전략이 실제로 쪼개는 상황은 39판에 1번뿐이라 그 값어치가 없다고 판단했다) */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bj_hand_user ON blackjack_hands(round_id, user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bj_hand_seat ON blackjack_hands(round_id, seat);

    /* ── 홀덤 프리롤 토너먼트 ────────────────────────────────────────
       구조는 스펙 9항의 Tournament → Tables → Seats → Players 를 그대로 따른다.
       지금은 한 테이블(STT)만 쓰지만 holdem_tables를 사이에 둬서 MTT로 늘릴 때
       스키마를 바꾸지 않아도 되게 했다.

       상태를 저장하는 원칙: "되돌릴 수 없는 사실"만 적는다.
       started_at / finished_at / cancelled_at 이 그 셋이고, 나머지(SCHEDULED·
       REGISTRATION_OPEN·WAITING_MIN_PLAYERS 같은 단계)는 시각에서 계산한다.
       서버가 절전에 들어가도 깨어나서 올바른 상태를 내려면 이래야 한다. */
    CREATE TABLE IF NOT EXISTS holdem_tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_str TEXT NOT NULL,              -- KST 'YYYY-MM-DD' — 하루 하나라는 규칙의 키
      title TEXT NOT NULL,
      reg_open_at INTEGER NOT NULL,
      scheduled_start_at INTEGER NOT NULL,
      grace_ends_at INTEGER NOT NULL,
      prize_multiplier INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    -- 하루에 토너먼트 하나. 동시에 두 개가 생기는 것을 DB가 막는다.
    /* 날짜는 더 이상 유일하지 않다. 하루에 여러 판을 열 수 있어야 하기 때문이다
       (이미 끝난 날에 한 판 더 열거나, 운영자가 임시 판을 여는 경우).
       대신 지켜야 할 규칙이 하나 남는다 — 살아 있는 판은 한 번에 하나뿐이다.
       그건 인덱스로 표현할 수 없어서(부분 유니크는 조건이 NULL 세 개에 걸린다)
       질의에서 막는다: db/holdem.ts 의 liveTournament, db/admin.ts 의 createTournament. */
    CREATE INDEX IF NOT EXISTS idx_ht_date2 ON holdem_tournaments(date_str, id DESC);

    /* 등록자. 상금 풀의 근거는 "누적 참가자 수"이므로 탈락해도 행을 지우지 않는다.
       freezeout이라 재입장이 없으니 (tournament_id, user_id)가 유니크다 —
       마지막 자리를 두고 두 요청이 겹쳐도 DB가 한쪽만 받는다. */
    CREATE TABLE IF NOT EXISTS holdem_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      finish_place INTEGER,                -- 1 = 우승. 토너먼트가 끝날 때 확정한다
      /* 탈락 순서(1부터). 등수를 탈락 시점에 "남은 인원 + 1"로 매기면 늦은 등록으로
         참가자가 늘었을 때 번호가 어긋난다(이미 4등을 준 뒤 5번째가 등록되는 경우).
         그래서 순서만 기록해 두고 등수는 끝날 때 한꺼번에 계산한다. */
      elim_seq INTEGER,
      eliminated_at INTEGER,
      prize INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_he_user ON holdem_entries(tournament_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_he_place ON holdem_entries(tournament_id, finish_place);

    CREATE TABLE IF NOT EXISTS holdem_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      table_no INTEGER NOT NULL DEFAULT 0,
      button_seat INTEGER NOT NULL DEFAULT 0,
      hand_no INTEGER NOT NULL DEFAULT 0,
      -- 다음 핸드를 시작할 시각. 쇼다운을 보여주는 동안 비어 있다.
      next_hand_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_htb_no ON holdem_tables(tournament_id, table_no);

    /* 좌석. 토너먼트 칩(스택)이 사는 곳이다 — 포인트가 아니라 칩이라 원장과 무관하다.
       presence는 접속 상태다: ACTIVE / SIT_OUT / DISCONNECTED / OUT(탈락).
       스펙 8항대로 브라우저가 끊겨도 자리를 빼지 않는다. */
    CREATE TABLE IF NOT EXISTS holdem_seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,               -- 0~8
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      stack INTEGER NOT NULL,
      presence TEXT NOT NULL DEFAULT 'ACTIVE',
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hs_seat ON holdem_seats(table_id, seat);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hs_user ON holdem_seats(table_id, user_id);

    /* 한 판(핸드). deck_json은 절대 클라이언트로 내보내지 않는다 —
       남은 카드가 새면 이후 모든 판이 무의미해진다. */
    CREATE TABLE IF NOT EXISTS holdem_hands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER NOT NULL,
      hand_no INTEGER NOT NULL,
      level INTEGER NOT NULL,
      sb INTEGER NOT NULL,
      bb INTEGER NOT NULL,
      ante INTEGER NOT NULL,
      button_seat INTEGER NOT NULL,
      deck_json TEXT NOT NULL,
      deck_pos INTEGER NOT NULL DEFAULT 0,
      board_json TEXT NOT NULL DEFAULT '[]',
      street TEXT NOT NULL DEFAULT 'preflop',
      to_act_seat INTEGER,
      action_deadline INTEGER,
      last_raise_size INTEGER NOT NULL DEFAULT 0,
      /* 이 핸드에서 가장 마지막으로 이뤄진 행동. 좌석의 last_action과 따로 두는 이유가 있다 —
         스트리트가 넘어갈 때 좌석의 행동 표시는 초기화되는데, 그 초기화가 스트리트를 넘긴
         바로 그 행동을 같은 트랜잭션에서 지워버린다. 폴링 주기가 1초라 클라이언트는
         그 행동을 한 번도 못 보고 보드가 깔리는 것만 본다("딜러가 체크했는데 안 보이고
         플랍이 바로 깔린다"). 여기 기록은 스트리트 초기화가 건드리지 않는다. */
      last_actor_seat INTEGER,
      last_actor_action TEXT,
      last_actor_amount INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER,
      result_json TEXT,                    -- 쇼다운 결과 (끝난 뒤에만 공개)
      started_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hh_no ON holdem_hands(table_id, hand_no);

    /* 핸드 안에서의 좌석 상태. hole_json은 본인에게만 내려보낸다.
       committed(핸드 총 투입액)가 사이드 팟 계산의 유일한 근거다 —
       스트리트별 bet만 들고 있으면 스트리트가 넘어갈 때 정보가 사라진다. */
    CREATE TABLE IF NOT EXISTS holdem_hand_seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hand_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      hole_json TEXT NOT NULL DEFAULT '[]',
      stack INTEGER NOT NULL,              -- 핸드 진행 중 남은 스택
      bet INTEGER NOT NULL DEFAULT 0,      -- 이 스트리트에 낸 금액
      committed INTEGER NOT NULL DEFAULT 0,-- 이 핸드에 총 낸 금액
      state TEXT NOT NULL DEFAULT 'active',-- active|folded|allin|out
      acted INTEGER NOT NULL DEFAULT 0,
      won INTEGER NOT NULL DEFAULT 0,
      /* 마지막으로 한 행동과 그 금액. 화면에 "콜 300"처럼 띄우려면 서버가 알려줘야 한다 —
         클라이언트가 베팅액 변화만 보고 유추하면 스트리트가 넘어갈 때 베팅이 0으로
         초기화되면서 무엇을 했는지 알 수 없고, 1초 폴링 사이에 두 번 행동하면 놓친다. */
      last_action TEXT,
      last_amount INTEGER NOT NULL DEFAULT 0,
      /* 판이 끝난 뒤 본인이 직접 패를 공개했는가. 래빗과 달리 서버에 남겨야 한다 —
         래빗은 나 혼자 보는 것이지만, 이건 남에게 보여주는 것이 목적이다. */
      shown INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hhs_seat ON holdem_hand_seats(hand_id, seat);

    /* 게임별 누적 성적. 랭킹 탭의 유일한 근거다.
       원장(points_ledger)에서 뽑지 않는다. 셋 다 원리적으로 불가능하다.
         1) 원장은 180일치만 남으므로(LEDGER_KEEP_DAYS) 통산 랭킹이 조용히
            슬라이딩 윈도우가 된다 — "8,602판"이 시간이 지나며 줄어든다.
         2) 바카라·포커의 정산 원장 행은 시장(market)당 하나이고 원장에 round_id가
            없어서 라운드 수를 셀 수 없다. 한 라운드에 5개 시장에 걸면 5판이 된다.
         3) 원장 행에는 그 판의 스테이크가 없어 푸시(순손익 0)를 승과 구분할 수 없다.
            게다가 바카라·블랙잭의 칩 회수는 베팅과 같은 reason에 양수 delta를 쓴다.
       시간이 아니라 유저 수 × 게임 수에만 비례하므로 pruneStaleData 대상이 아니다. */
    CREATE TABLE IF NOT EXISTS game_stats (
      user_id  TEXT NOT NULL,
      game     TEXT NOT NULL,                 -- mines|ladder|graph|poker|baccarat|blackjack
      rounds   INTEGER NOT NULL DEFAULT 0,     -- 판수 (푸시 포함)
      wins     INTEGER NOT NULL DEFAULT 0,     -- 순손익이 양수인 판
      /* 승패를 아는 판수. 원장에서 백필한 과거 판은 스테이크와 지급을 짝지을 수 없어
         승·패·푸시를 판정할 수 없다(원장 행에 round_id가 없다). 그런 판은 rounds에는
         들어가지만 rated에는 안 들어가고, 승률은 rated 기준으로만 계산한다 —
         그래야 과거 판이 전부 패배로 잡혀 승률이 거짓이 되는 일이 없다. */
      rated    INTEGER NOT NULL DEFAULT 0,
      pushes   INTEGER NOT NULL DEFAULT 0,     -- 순손익이 0인 판 (승률 분모에서 뺀다)
      staked   INTEGER NOT NULL DEFAULT 0,
      returned INTEGER NOT NULL DEFAULT 0,
      /* returned - staked. 정렬 키라서 파생값이어도 컬럼으로 둔다.
         감사가 profit == returned - staked 를 항상 검사한다. */
      profit   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, game)
    );
    CREATE INDEX IF NOT EXISTS idx_gstats_rank ON game_stats(game, profit DESC);

    /* ── 시즌 ────────────────────────────────────────────────────────
       시즌이 넘어가면 전부 초기화된다 — 잔액도, 게임별 전적도. 그래서 "지운다"가 아니라
       "시즌을 열쇠에 넣는다". 새 시즌은 행이 없으니 저절로 0에서 시작하고, 지난 시즌은
       그대로 남아 언제든 다시 볼 수 있다. 지우는 설계였다면 지난 시즌을 못 보여준다. */
    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL UNIQUE,        -- 화면에 적는 번호 (0부터)
      name TEXT NOT NULL,                    -- '오픈베타' 처럼 번호 옆에 붙는 이름
      reward TEXT NOT NULL DEFAULT '',       -- 보상 안내 문구 (자유 형식)
      started_at INTEGER NOT NULL,
      ends_at INTEGER,                       -- 예정 종료 시각 (안내용, 없으면 미정)
      closed_at INTEGER                      -- 실제로 닫힌 시각. NULL 이면 진행 중
    );

    /* 게임별 전적을 시즌 단위로 쌓는다. game_stats 와 열이 같지만 따로 두는 이유가 있다 —
       game_stats 는 통산 기록이고 여기는 시즌 기록이라 뜻이 다르다. 한 테이블에 시즌을
       끼워 넣으려면 기본키를 바꿔야 하는데 SQLite 는 그걸 못 하고, 옮기는 과정에서
       통산 기록이 위험해진다. 쓰는 곳은 bumpGameStats 한 군데뿐이라 둘을 함께 올린다. */
    CREATE TABLE IF NOT EXISTS season_stats (
      season_id INTEGER NOT NULL,
      user_id  TEXT NOT NULL,
      game     TEXT NOT NULL,
      rounds   INTEGER NOT NULL DEFAULT 0,
      rated    INTEGER NOT NULL DEFAULT 0,
      wins     INTEGER NOT NULL DEFAULT 0,
      pushes   INTEGER NOT NULL DEFAULT 0,
      staked   INTEGER NOT NULL DEFAULT 0,
      returned INTEGER NOT NULL DEFAULT 0,
      profit   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (season_id, user_id, game)
    );
    CREATE INDEX IF NOT EXISTS idx_sstats_rank ON season_stats(season_id, game, profit DESC);

    /* 시즌이 닫힐 때 찍는 성적표. 시즌 점수는 "종료 시점 잔액"이라, 닫는 순간을 놓치면
       영영 알 수 없다 — 잔액은 다음 시즌이 시작되면서 초기화되기 때문이다.
       진행 중인 시즌의 순위는 이 표가 아니라 users.balance 를 실시간으로 본다. */
    CREATE TABLE IF NOT EXISTS season_results (
      season_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      balance INTEGER NOT NULL,              -- 종료 시점 잔액 = 그 시즌의 점수
      rank INTEGER NOT NULL,
      PRIMARY KEY (season_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sres_rank ON season_results(season_id, rank);

    /* 대회 운영 설정. 코드에 박혀 있던 값을 운영자가 고칠 수 있게 한다.
       키-값으로 두는 이유: 항목이 늘 때마다 컬럼을 추가하고 마이그레이션을 쓰는 대신
       한 줄만 더하면 되고, 값이 없으면 코드의 기본값이 그대로 쓰인다(폴백).
       여기 값을 바꿔도 이미 만들어진 대회는 흔들리지 않는다 — 대회를 만들 때 그 시점의
       설정을 대회 행에 박아 두고, 진행 중에는 행의 값만 본다. */
    /* 공지사항.
       원래는 코드(web/notices.ts)에 있었다. "글이 자주 올라오는 곳이 아니고, 코드에 두면
       배포와 함께 버전 관리된다"는 판단이었는데, 글 한 줄을 고치려고 배포를 해야 하는 것이
       실제로는 더 컸다. 이제 DB 에 두고 운영자 화면에서 고친다.

       본문 구조(sections)는 코드에 있던 모양을 그대로 옮긴다 — 제목·문단·목록·표.
       JSON 으로 넣는 이유는 절 하나당 표까지 들어갈 수 있어서 열로 펴면 표가 세 벌 되기
       때문이다. 화면이 읽는 모양은 예전과 같으므로 보이는 것은 달라지지 않는다.

       id 는 URL 에 그대로 쓰인다. 한 번 정하면 바꾸지 않는다 — 링크를 공유한 사람의
       주소가 깨진다. 그래서 지우기와 별개로 '숨김'을 둔다. */
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,                    -- 'YYYY-MM-DD' (KST)
      kind TEXT NOT NULL,                    -- 업데이트|밸런스|버그 수정|신규|점검|이벤트
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      sections_json TEXT NOT NULL,           -- NoticeSection[] 그대로
      active INTEGER NOT NULL DEFAULT 1,     -- 0이면 목록에도 상세에도 안 나온다
      sort_at INTEGER NOT NULL,              -- 정렬 기준(최신이 위). 같은 날짜의 순서를 정한다
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_notices_order ON notices(active, sort_at DESC);

    CREATE TABLE IF NOT EXISTS holdem_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // 기존 DB에도 컬럼을 비파괴적으로 추가 (discord-lol과 동일한 additive 마이그레이션 방식)
  try { d.exec(`ALTER TABLE crash_bets ADD COLUMN auto_cashout REAL`); } catch {}
  // 사다리: 두 번째 예측을 도착 좌/우 → 줄수 홀/짝('ODD'|'EVEN')으로 변경. 의미가 다르므로 새 컬럼을 쓴다.
  try { d.exec(`ALTER TABLE ladder_bets ADD COLUMN parity_guess TEXT`); } catch {}
  // 개인회생 지원금(파산 구제)을 마지막으로 받은 시각(unix초). 쿨다운 판정에 쓴다.
  try { d.exec(`ALTER TABLE users ADD COLUMN last_relief_at INTEGER`); } catch {}
  // 홀덤: 마지막 행동 표시 (이미 만들어진 DB에도 붙인다)
  try { d.exec(`ALTER TABLE holdem_hand_seats ADD COLUMN last_action TEXT`); } catch {}
  try { d.exec(`ALTER TABLE holdem_hand_seats ADD COLUMN last_amount INTEGER NOT NULL DEFAULT 0`); } catch {}
  // 홀덤: 판이 끝난 뒤 자발적 패 공개
  try { d.exec(`ALTER TABLE holdem_hand_seats ADD COLUMN shown INTEGER NOT NULL DEFAULT 0`); } catch {}
  /* 어느 장을 깠는가 — 1비트가 첫 장, 2비트가 둘째 장이다(0·1·2·3).
     기본값은 0(아무것도 안 깜)이다. 새 행이 3으로 시작하면 "한 장만 깐다"가 성립하지
     않는다 — 비트를 더해 나가는 방식이라 처음부터 3이면 무엇을 더해도 3이다.

     대신 이미 있는 행은 한 번만 3으로 올린다. 예전에는 공개가 "두 장 전부"뿐이었으므로
     shown=1 인 지난 판은 두 장을 깐 것이 맞다. 안 올리면 지난 판들이 조용히
     "아무것도 안 깐" 것으로 바뀐다. 새로 추가한 직후에만 도는 문장이라 한 번만 돈다. */
  try {
    d.exec(`ALTER TABLE holdem_hand_seats ADD COLUMN shown_mask INTEGER NOT NULL DEFAULT 0`);
    d.exec(`UPDATE holdem_hand_seats SET shown_mask = 3 WHERE shown = 1`);
  } catch { /* 이미 있다 */ }
  // 랭킹: 승률을 계산할 수 있는 판수 (백필한 과거 판은 여기 들어가지 않는다)
  try { d.exec(`ALTER TABLE game_stats ADD COLUMN rated INTEGER NOT NULL DEFAULT 0`); } catch {}
  // 홀덤: 스트리트를 닫은 마지막 행동 (스트리트 초기화가 지우지 못하는 자리)
  try { d.exec(`ALTER TABLE holdem_hands ADD COLUMN last_actor_seat INTEGER`); } catch {}
  try { d.exec(`ALTER TABLE holdem_hands ADD COLUMN last_actor_action TEXT`); } catch {}
  try { d.exec(`ALTER TABLE holdem_hands ADD COLUMN last_actor_amount INTEGER NOT NULL DEFAULT 0`); } catch {}

  /* 대회를 만들 때의 설정을 그 대회 행에 박아 둔다.
     일정과 상금 배수는 원래부터 행에 있었지만 스타팅 칩·블라인드 주기·레이트 레지는
     코드 상수를 실시간으로 읽고 있었다 — 운영자가 값을 바꾸는 순간 진행 중인 대회의
     블라인드가 뛰거나 늦게 온 사람만 다른 스택을 받는다. 행에 박아 두면 그런 일이 없다.
     0 이면 "코드 기본값을 쓴다"는 뜻이라, 이미 있던 행도 그대로 동작한다. */
  /* 하루 하나를 강제하던 유니크 인덱스를 걷어낸다. 이미 만들어진 DB 에도 남아 있으므로
     여기서 지운다 — 안 지우면 두 번째 판을 만들 때 INSERT 가 조용히 실패한다. */
  try { d.exec(`DROP INDEX IF EXISTS idx_ht_date`); } catch { /* 없으면 그만 */ }

  for (const col of [
    'starting_stack INTEGER NOT NULL DEFAULT 0',
    'level_sec INTEGER NOT NULL DEFAULT 0',
    'late_reg_sec INTEGER NOT NULL DEFAULT 0',
    'prize_fixed INTEGER NOT NULL DEFAULT 0',      // 0보다 크면 인원과 무관한 고정 상금 풀
    /* 참가비. 0 이면 프리롤이고, 그게 기본값이라 이미 있는 행은 전부 프리롤로 읽힌다.
       0보다 크면 등록할 때 그만큼 걷고, 걷은 돈이 상금 풀이 된다. */
    'buy_in INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { d.exec(`ALTER TABLE holdem_tournaments ADD COLUMN ${col}`); } catch { /* 이미 있다 */ }
  }
  /* 실제로 걷은 금액을 참가 행에 남긴다.
     설정의 참가비를 다시 읽어 되돌리면 그 사이에 값이 바뀌었을 때 걷은 것과 다른 액수를
     돌려주게 된다 — "잔액 = 원장 누적합"이 그 자리에서 깨진다. 받은 만큼만 돌려준다. */
  try {
    d.exec(`ALTER TABLE holdem_entries ADD COLUMN paid_in INTEGER NOT NULL DEFAULT 0`);
  } catch { /* 이미 있다 */ }
}
