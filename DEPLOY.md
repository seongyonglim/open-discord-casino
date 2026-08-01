# 배포 가이드

디스코드 앱 등록 → fly.io 배포 → 검증까지의 순서다. **순서를 지켜야 한다.**
디스코드에 인터랙션 엔드포인트를 등록하는 순간 디스코드가 서명된 PING을 쏘기 때문에,
서버가 먼저 떠 있고 `DISCORD_PUBLIC_KEY`가 이미 들어가 있어야 등록이 성공한다.

배포 전 자동 점검:

```bash
npm run smoke
```

시크릿이 하나도 없는 상태로 실서버와 같은 조건(`FLY_APP_NAME` 설정)의 서버를 임시로 띄워
34개 항목을 확인한다. 로컬 `data.db`는 건드리지 않는다.

---

## 1. 디스코드 앱 등록

<https://discord.com/developers/applications> → **New Application** (이름: 예 `OPEN DISCORD 카지노`)

다음 4개 값을 받아 적는다.

| 값 | 위치 | 환경변수 |
| --- | --- | --- |
| Application ID | General Information | `CLIENT_ID`, `DISCORD_CLIENT_ID` (같은 값) |
| Public Key | General Information | `DISCORD_PUBLIC_KEY` |
| Client Secret | OAuth2 → **Reset Secret** | `DISCORD_CLIENT_SECRET` |
| Bot Token | Bot → **Reset Token** | `DISCORD_TOKEN` |

Client Secret과 Bot Token은 **재발급 시 한 번만 보인다.** 창을 닫기 전에 복사할 것.

추가로 필요한 값:

- **길드 ID** — 디스코드 앱에서 개발자 모드를 켜고(설정 → 고급 → 개발자 모드) 서버 우클릭 → ID 복사
  → `GUILD_ID`, `DISCORD_GUILD_ID` (같은 값)
- **본인 디스코드 ID** — 자기 프로필 우클릭 → ID 복사 → `SEED_ADMIN_DISCORD_ID`
  (이 값이 `/출석판생성`을 쓸 수 있는 관리자를 정한다)

### 봇 설정

Bot 탭에서:

- **Public Bot** 끄기 (이 서버 전용)
- Privileged Gateway Intents는 **전부 끌 것.** 게이트웨이에 접속하지 않는 구조라 필요 없다.

> OAuth2 리다이렉트 URI와 Interactions Endpoint URL은 **3번, 5번 단계에서** 넣는다.
> 지금 넣으면 서버가 없어서 검증이 실패한다.

---

## 2. fly.io 앱과 볼륨 생성

`fly.toml`은 이미 커밋돼 있다. 앱 이름은 `open-discord-casino`, 리전은 `nrt`(도쿄)다.

```bash
flyctl apps create open-discord-casino --org personal
```

```bash
flyctl volumes create discord_casino_data --region nrt --size 1 -a open-discord-casino
```

볼륨은 SQLite 파일이 사는 곳이다. `fly.toml`이 이걸 `/data`에 마운트하고,
`DB_PATH=/data`이므로 DB는 `/data/data.db`가 된다. **볼륨 없이 배포하면 재시작마다 포인트가 전부 날아간다.**

> `flyctl launch`는 쓰지 않는다. 기존 `fly.toml`을 덮어써서 scale-to-zero 설정을 잃을 수 있다.

---

## 3. 시크릿 설정

한 번에 넣는다 (여러 번 나눠 넣으면 그때마다 머신이 재시작된다).
아래 `<...>` 부분을 1번에서 받아 적은 값으로 채운다.

```bash
flyctl secrets set -a open-discord-casino DISCORD_TOKEN='<Bot Token>' DISCORD_PUBLIC_KEY='<Public Key>' CLIENT_ID='<Application ID>' DISCORD_CLIENT_ID='<Application ID>' DISCORD_CLIENT_SECRET='<Client Secret>' GUILD_ID='<길드 ID>' DISCORD_GUILD_ID='<길드 ID>' SEED_ADMIN_DISCORD_ID='<본인 디스코드 ID>' DISCORD_OAUTH_REDIRECT_URI='https://open-discord-casino.fly.dev/auth/callback'
```

주의사항:

- `CLIENT_ID`와 `DISCORD_CLIENT_ID`는 **같은 값**이다 (슬래시 커맨드 등록용 / 웹 OAuth용으로 이름이 갈려 있다).
  `GUILD_ID`와 `DISCORD_GUILD_ID`도 마찬가지다.
- `PREVIEW_LOGIN`은 **절대 넣지 않는다.** 로그인 우회용이다.
  (넣어도 fly에서는 `FLY_APP_NAME` 감지로 닫히지만, 애초에 넣을 이유가 없다.)
- `PORT`와 `DB_PATH`는 `fly.toml`에 있으므로 시크릿으로 넣지 않는다.

확인:

```bash
flyctl secrets list -a open-discord-casino
```

---

## 4. 배포

로컬 Docker 데몬이 꺼져 있어도 되도록 fly 빌더에서 빌드한다.

```bash
flyctl deploy -a open-discord-casino --remote-only
```

배포 후 응답 확인:

```bash
curl -i https://open-discord-casino.fly.dev/health
```

`200 ok`가 나와야 한다. 안 나오면 로그를 본다.

```bash
flyctl logs -a open-discord-casino
```

---

## 5. 디스코드 포털에 URL 등록 (서버가 뜬 뒤에)

**General Information → Interactions Endpoint URL**

```
https://open-discord-casino.fly.dev/discord/interactions
```

저장하면 디스코드가 서명된 PING을 보내고, 서버가 PONG을 돌려줘야 저장이 완료된다.
실패하면 `DISCORD_PUBLIC_KEY`가 틀렸거나 배포가 아직 안 끝난 것이다.

**OAuth2 → Redirects → Add Redirect**

```
https://open-discord-casino.fly.dev/auth/callback
```

3번에서 넣은 `DISCORD_OAUTH_REDIRECT_URI`와 **한 글자도 다르면 안 된다.**

---

## 6. 슬래시 커맨드 등록

로컬 `.env`에 `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`를 채운 뒤:

```bash
npm run deploy
```

`/내점수`, `/랭킹`, `/출석판생성` 3개가 해당 길드에 등록된다.
길드 한정 등록이라 즉시 반영된다(전역 등록은 최대 1시간 걸린다).

---

## 7. 봇을 서버에 초대

OAuth2 → URL Generator에서:

- **Scopes**: `bot`, `applications.commands`
- **Bot Permissions**: `Send Messages` (출석판 메시지를 채널에 올리는 데만 쓴다)

생성된 URL로 접속해 서버에 초대한다.

---

## 8. 배포 후 검증

### 8-1. 기본 동작

1. `https://open-discord-casino.fly.dev` 접속 → 디스코드 로그인 → 로비가 보이는지
2. 길드 멤버가 아닌 계정으로 로그인 시 `?login=notmember`로 튕기는지
3. 게임 4개(포커 플립 · 사다리 · 그래프 · 지뢰찾기) 진입 및 베팅
4. 디스코드에서 `/내점수`, `/랭킹` 응답 확인
5. `/출석판생성` → 출석체크 버튼 눌러 포인트 지급 확인

### 8-2. 절전 동작 확인 (요금에 직결)

아무도 접속하지 않은 상태로 10분 이상 둔 뒤:

```bash
flyctl machine list -a open-discord-casino
```

`STATE`가 `suspended`여야 한다. `started`로 남아 있으면 요금이 상시 가동($2.02/월)으로 고정된다.

**2026-08-01 실측**: 마지막 요청 후 **약 7분**에 `suspended`로 전환됐다
(1분 간격 확인 — 6분까지 `started`, 7분에 `suspended`).

### 8-3. 디스코드 3초 제한 — 이미 해결됨 (실측 기록)

디스코드 인터랙션은 **3초 안에** 응답해야 한다. 실측 결과:

| 절전 방식 | 깨우는 시간 | 판정 |
| --- | --- | --- |
| `stop` (기본값) | **9.05초** | 초과 — 출석체크 버튼이 실패한다 |
| `suspend` (현재 설정) | **1.32초** | 통과 |

`stop`이 9초나 걸리는 이유는 fly 머신 부팅에 더해 컨테이너 안에서 tsx가 TypeScript를
런타임 트랜스파일하기 때문이다(배포 로그상 머신 기동 후 서버 바인딩까지 약 6초).
`suspend`는 램 스냅샷에서 재개하므로 이 과정을 건너뛴다.

그래서 `fly.toml`은 `auto_stop_machines = "suspend"`를 쓴다. **stop으로 되돌리지 말 것.**
볼륨 데이터가 suspend/resume을 넘겨 유지되는 것도 확인했다(`/data/data.db` 그대로, SQLite 정상 오픈).

남은 미확인 사항은 **suspend 중 컴퓨트 과금 여부**다(공식 문서에 없음).
며칠 뒤 fly 대시보드 청구 내역으로 확인하고, 가동으로 과금된다면
`min_machines_running = 1`로 상시 가동하는 게 더 단순하다(어차피 같은 $2.02/월).

디스코드 연동을 붙인 뒤에는 실제로도 확인할 것:

1. 8-2로 `suspended` 확인
2. 그 상태에서 디스코드 출석체크 버튼을 누른다
3. 정상 응답이 오면 통과. `애플리케이션이 응답하지 않습니다`가 뜨면 실패

---

## 운영 명령어

| 목적 | 명령 |
| --- | --- |
| 로그 실시간 보기 | `flyctl logs -a open-discord-casino` |
| 머신 상태 | `flyctl machine list -a open-discord-casino` |
| 재시작 | `flyctl machine restart <머신ID> -a open-discord-casino` |
| 운영 DB 내려받아 열기 | `npm run db:admin` |
| 시크릿 변경 | `flyctl secrets set -a open-discord-casino KEY='값'` |
| 배포 되돌리기 | `flyctl releases -a open-discord-casino` 후 `flyctl deploy --image <이전 이미지>` |

---

## 데이터 보존 정책

볼륨이 무한정 차지 않도록 다음이 자동 정리된다 (`src/db/queries.ts`, 프로세스당 1시간에 한 번).

| 대상 | 보존 기간 |
| --- | --- |
| 라운드 기록 (포커·사다리·그래프) | 최근 30판 |
| `points_ledger` (포인트 증감 감사 이력) | 180일 |
| `game_rounds` (지뢰찾기, 정산 완료분) | 30일 |
| 만료된 웹 세션 | 즉시 |

`users`(잔액·연속출석일)는 **정리하지 않는다** — 지워지면 안 되는 데이터다.
