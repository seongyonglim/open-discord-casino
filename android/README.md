# 안드로이드 APK 만들기 (TWA)

이 앱은 별도의 안드로이드 코드가 없다. TWA(Trusted Web Activity)는 이 사이트를
크롬으로 그대로 띄우는 껍데기이고, Bubblewrap 이 그 껍데기를 만들어 준다.

준비는 끝나 있다.

| 항목 | 상태 |
|---|---|
| 매니페스트 `/manifest.webmanifest` | 배포됨 |
| 아이콘 192·512·마스커블·180 | 배포됨 |
| 서비스워커 `/sw.js` | 배포됨 |
| 크롬 설치 판정 | 오류 없음 (Chrome 151 확인) |
| `/.well-known/assetlinks.json` | 라우트 있음 · 지문은 아직 비어 있음 |
| Bubblewrap CLI | 설치됨 |
| JDK 17 | 설치됨 · `~/.bubblewrap/config.json` 에 연결됨 |

남은 것은 두 가지뿐이고, 둘 다 **직접 하셔야 한다.**

- **안드로이드 SDK 라이선스 동의** — 구글과 맺는 법적 동의라 대신 눌러 줄 수 없다.
- **키스토어 암호** — 앱 서명 키의 암호다. 암호는 대신 입력하지 않는다.

---

## 1. 프로젝트 만들기

```
npx @bubblewrap/cli init --manifest https://odcasino.kro.kr/manifest.webmanifest
```

질문이 이어진다. 아래 값으로 답하면 된다(엔터만 쳐도 되는 것은 "기본값").

| 질문 | 답 |
|---|---|
| Domain | `odcasino.kro.kr` (기본값) |
| Name / Launcher name | `OD CASINO` (기본값) |
| Application ID | `kr.kro.odcasino` |
| Display mode | `standalone` (기본값) |
| Orientation | `default` |
| Status bar color | `#050506` (기본값) |
| Icon URL | 기본값 |
| Maskable icon URL | 기본값 |
| Include support for Play Billing? | `No` |
| Signing key 만들지 | `Yes` — 그리고 **암호를 정한다** |

암호는 잊으면 안 된다. Play 스토어에 올린 뒤 같은 키로만 갱신할 수 있다.

중간에 안드로이드 SDK 를 받겠냐고 물으면 `Yes`, 라이선스는 읽고 동의한다.

## 2. APK 굽기

```
npx @bubblewrap/cli build
```

끝나면 `app-release-signed.apk` 가 나온다. 그 파일을 폰으로 옮겨 실행하면 설치된다
(설정에서 "출처를 알 수 없는 앱" 을 한 번 허용해야 할 수 있다).

## 3. 주소창 없애기

여기까지만 해도 앱은 돌지만 위에 주소창이 남는다. 안드로이드가 "이 앱이 정말 그
사이트 것인가" 를 확인하지 못했기 때문이다. 확인의 근거가 서명 키의 지문이다.

```
keytool -list -v -keystore android.keystore -alias odcasino
```

출력에서 `SHA256:` 로 시작하는 줄을 알려 주면 `/.well-known/assetlinks.json` 에
넣어 배포한다. **지문은 비밀이 아니다** — 공개 주소로 내보내라고 만들어진 값이고,
그것만으로는 서명할 수 없다(서명에는 키스토어 파일과 암호가 필요하고 그 둘은 이
저장소에 없다).

Play 스토어에 올리면 구글이 다시 서명하므로 지문이 하나 더 생긴다. 그때는 Play Console
의 "앱 서명" 화면에 있는 SHA-256 도 같이 넣어야 두 경로 모두 주소창이 사라진다
(`src/web/pwa.ts` 의 `TWA_FINGERPRINTS` 가 배열인 이유다).

---

## 지금 그냥 폰에서 보고 싶다면

APK 없이도 된다. 폰 크롬으로 https://odcasino.kro.kr 을 열고 **홈 화면에 추가**하면
주소창 없는 앱으로 뜬다. 화면은 APK 로 만든 것과 같다 — TWA 도 같은 크롬으로 같은
페이지를 띄우기 때문이다. APK 가 더 주는 것은 Play 스토어 배포 경로다.
