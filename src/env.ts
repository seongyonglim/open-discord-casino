// 환경변수(시크릿) 읽기 공용 헬퍼.
//
// 셸마다 따옴표 처리가 달라서 값에 따옴표가 그대로 실려 오는 사고가 흔하다.
// bash는 'abc' 에서 따옴표를 벗기지만 cmd.exe는 벗기지 않아서
// `flyctl secrets set DISCORD_TOKEN='...'` 를 cmd에서 실행하면 따옴표까지 저장된다.
// 실제로 이 프로젝트 배포 중 봇 토큰이 그렇게 저장돼(길이 72 → 74)
// 디스코드가 401 Unauthorized를 주고, 원인이 값 자체가 아니라 따옴표라는 게
// 드러나기까지 시간이 걸렸다. 값을 읽는 지점에서 한 겹만 걷어내 같은 사고를 막는다.
//
// 한 겹만 벗긴다 — 진짜로 따옴표로 시작하고 끝나는 값(그런 시크릿은 없지만)을
// 통째로 망가뜨리지 않기 위해서다.
export function env(name: string): string {
  const raw = process.env[name];
  if (!raw) return '';
  const v = raw.trim();
  if (v.length >= 2) {
    const first = v[0], last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1).trim();
    }
  }
  return v;
}
