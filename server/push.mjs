// 웹 푸시 알림 (RFC 8030 · 8291 aes128gcm · 8292 VAPID) — 외부 라이브러리 없이 node:crypto 로
// 구독은 브라우저(PWA·안드로이드 앱)가 만들고, 서버는 그 주소로 암호화한 알림을 보냄.
// 알림 내용은 로그에 남기지 않고, 보낸 개수만 남김.
import crypto from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");

// 알려진 푸시 서비스 주소만 받음 (다른 서버로 요청을 보내게 하는 일을 막음)
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function pushEndpointOk(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname)) && endpoint.length <= 1000;
  } catch { return false; }
}

// VAPID 키: 처음 한 번 만들어 settings 에 둠 (공개키는 브라우저 구독에 씀)
export function vapidKeys(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (row) { try { const v = JSON.parse(row.value); if (v.publicKey && v.privateJwk) return v; } catch { /* 다시 만듦 */ } }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const v = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateJwk: privateKey.export({ format: "jwk" }) };
  db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(v));
  return v;
}

// VAPID JWT (ES256): 푸시 서비스에 '이 서버가 보냈다'를 증명
export function vapidAuth(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
// RFC 8291 aes128gcm 암호화: 받는 쪽 공개키(p256dh)·비밀(auth)로 한 번 쓰고 버리는 키를 만들어 감쌈
export function encryptPayload(payload, p256dh, auth, fixed) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("bad subscription keys");
  // fixed 는 RFC 8291 예시 값으로 확인할 때만 (salt·서버 쪽 임시 비밀키)
  const salt = fixed ? unb64u(fixed.salt) : crypto.randomBytes(16), ecdh = crypto.createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(unb64u(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, enc]);
}

// 시험용 복호화 (받는 쪽 역할): CI 에서 암호화가 맞는지 확인
export function decryptPayload(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), enc = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey(), authSecret = unb64u(auth);
  const shared = uaEcdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(enc.subarray(enc.length - 16));
  const out = Buffer.concat([d.update(enc.subarray(0, enc.length - 16)), d.final()]);
  return out.subarray(0, out.lastIndexOf(2)).toString();
}

// 구독 하나로 보내기. 404·410 이면 구독이 없어진 것이라 지움
export async function sendPush(db, vapid, sub, message, subject) {
  const body = encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST", signal: ctl.signal, body,
      headers: { Authorization: vapidAuth(vapid, sub.endpoint, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" }
    });
    const gone = r.status === 404 || r.status === 410;
    if (gone) db.prepare("DELETE FROM push_subs WHERE id = ?").run(sub.id);
    // 실패하면 원인을 남김: 응답 코드·푸시 서비스 이름·서비스가 준 이유 (알림 내용·구독 주소·계정은 남기지 않음)
    if (r.status < 200 || r.status >= 300) {
      const reason = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      console.log(`[push] 실패 ${r.status} ${new URL(sub.endpoint).hostname}${gone ? " (구독 지움)" : ""} ${reason}`);
    }
    return r.status;
  } catch (e) {
    console.log(`[push] 실패 연결 ${new URL(sub.endpoint).hostname} ${e?.name === "AbortError" ? "시간 초과" : String(e?.message || e).slice(0, 120)}`);
    return 0;
  } finally { clearTimeout(t); }
}
