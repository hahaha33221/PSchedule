/*
 * 부재 제목에서 이름·종류 나누기 ('김시험_연차' → 이름 '김시험', 종류 '연차')
 *   - 이름은 적힌 그대로 둠 (여러 명이면 쉼표까지 그대로, 사람마다 쪼개지 않음)
 *   - '이름들 + 종류' 꼴이 분명할 때만 나눔. 애매하면 null → 화면은 제목 그대로
 */
const REST = "연차휴가|연차|반반차|반차|휴가|병가|공가|대휴|대체휴무|조퇴|휴직|경조휴가|재택근무|재택";
const AWAY = "피정|연수|교육|출장|외근"; // 행사 이름일 수도 있어 앞이 이름 꼴일 때만
const KIND = `(?:오전|오후)\\s*(?:${REST})|${REST}|${AWAY}`;
const RE = new RegExp(`^(.+?)\\s*[_\\-,\\s]\\s*(${KIND})\\s*(\\((?:${KIND}|[가-힣0-9A-Za-z:~\\s-]{1,15})\\))?$`);
const PERSON = /^(?:(?:Fr|Sr|Br)\.?\s*)?[가-힣A-Za-z]{1,12}(?:\([가-힣A-Za-z]{1,6}\))?$/i;

export function parseAbsence(title) {
  const t = String(title ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const m = RE.exec(t);
  if (!m) return null;
  const name = m[1].replace(/[\s,]+$/, ""), kind = m[2].replace(/\s+/g, " ") + (m[3] ? ` ${m[3]}` : "");
  // 이름 자리: 한글·영문·쉼표·마침표만 (괄호는 이름 뒤 짧은 것만). 종류가 또 들어 있거나 / [ ] 숫자가 있으면 애매함
  if (!name || name.length > 80 || /[[\]/_\-~0-9<>]/.test(name)) return null;
  const people = name.split(",").map((x) => x.trim()).filter(Boolean);
  if (!people.length || people.some((x) => new RegExp(`(?:${REST})$`).test(x))) return null;
  const clear = people.every((x) => PERSON.test(x));
  // 쉼표 없이 띄어 쓴 것('가나다 라마바 연차')은 그대로 두되, 쉬는 종류이고 글자만 있을 때만
  if (!clear && (new RegExp(`^(?:${AWAY})`).test(m[2]) || !people.every((x) => /^[가-힣A-Za-z.\s]+(?:\([가-힣A-Za-z]{1,6}\))?$/.test(x)))) return null;
  return { name, kind };
}
