// 로컬 미리보기용 테스트 계정/세션 시드 (커밋 대상 아님)
import { upsertUser, adjustBalance, createSession } from './src/db/queries';

const users: [string, string, string][] = [
  ['preview-user', '미리보기', 'previewsessiontoken000'],
  ['preview-user-2', '두번째유저', 'previewsessiontoken111'],
];

for (const [uid, name, token] of users) {
  upsertUser(uid, name, null);
  adjustBalance(uid, 50000, 'preview_seed');
  createSession(token, uid, Math.floor(Date.now() / 1000) + 3600 * 6);
  console.log(`${name}: ${token}`);
}
