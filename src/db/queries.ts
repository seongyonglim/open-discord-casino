/* 데이터베이스 질의 — 도메인별 모듈의 배럴.

   한 파일에 1,792줄이 쌓여 있어서 무엇을 고치든 파일 전체를 훑어야 했다. 도메인별로
   나누되 이 파일은 남긴다 — 저장소 곳곳에서 './queries' 를 가져다 쓰고 있고, 그 경로를
   전부 고치는 것은 나누는 일과 아무 상관이 없는 변경이라 위험만 늘린다.

   실제 내용은 queries/ 안에 있다. 새 질의를 넣을 때는 도메인 파일에 넣고, 새 도메인이
   생기면 여기에 한 줄을 더한다.

   의존은 한 방향이다: 게임별 모듈 → core. core 는 게임을 몰라야 한다. */
export * from './queries/core';
export * from './queries/ladder';
export * from './queries/crash';
export * from './queries/poker';
export * from './queries/bacc';
export * from './queries/bj';
