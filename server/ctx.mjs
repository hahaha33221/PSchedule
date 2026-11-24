// 지금 요청을 보낸 사람 (상태 이력·변경 내역에 남김). 요청 밖(시간마다 도는 일)에서는 없음 → '자동'
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
export const setActor = (user) => als.enterWith({ user });
export const actor = () => als.getStore()?.user || null;
