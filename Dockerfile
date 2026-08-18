FROM node:22-slim

WORKDIR /app

COPY package*.json ./
# 컴파일에 typescript 가 필요하므로 dev 의존성까지 받는다. 끝나면 덜어낸다.
RUN npm ci

COPY . .

# 런타임에 TypeScript 를 컴파일하지 않는다.
# 예전에는 `--require tsx/cjs src/index.ts` 로 띄웠는데, 그러면 컴파일러와 그 캐시를
# 프로세스가 계속 들고 있는다 — 같은 서버를 두 방식으로 띄워 재 보니 기본 메모리가
# 88MB(컴파일본) 대 131MB(tsx) 였다. 512MB 머신에서 43MB 는 작지 않다.
RUN npx tsc && npm prune --omit=dev

RUN mkdir -p /data

# --max-old-space-size 를 주는 이유:
# V8 은 머신 메모리를 보고 힙 상한을 정한다. 512MB 머신에서 상한을 안 주면 큰 GC 를
# 미루면서 계속 자라고, 운영에서 실제로 RSS 381MB / 여유 22MB 까지 갔다(안 새고 그
# 수준에서 평형이었다). 여유가 5% 밖에 없으면 GC 가 자주·길게 돌아 이따금 응답이
# 몇 초씩 멈춘다 — 로그에 4921ms 짜리 인터랙션이 한 건 남아 있었다.
# 상한을 주면 그 전에 정리하며 돈다. 정적 파일 캐시 등 힙 밖 메모리가 있으므로
# 머신 용량의 절반쯤에 둔다.
CMD ["node", "--experimental-sqlite", "--max-old-space-size=256", "dist/index.js"]
