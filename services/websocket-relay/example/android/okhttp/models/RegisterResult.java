package com.wsrelay.api.models;

import org.json.JSONObject;

/**
 * Reply from the register / unregister endpoints.
 *
 * <pre>
 * { "title": "websocket-relay", "result": "success", "status": "approved",
 *   "message": "…",
 *   "sip": { "user": "0101080501", "domain": "pluto.org", "password": "…" },
 *   "clientCert": "-----BEGIN CERTIFICATE-----…" }
 * </pre>
 *
 * Older relay builds returned this as a JSON-ish *string* rather than real
 * JSON. The current server returns proper JSON; the client tolerates both.
 *
 * <h3>{@link #sip} 는 없을 수 있다 — 오류가 아니다</h3>
 * 두 경우다.
 * <ul>
 *   <li>아직 승인되지 않은 단말 ({@code status} 가 {@code "pending"})</li>
 *   <li>번호를 만들 수 없는 세대 — {@code A동} 처럼 숫자가 아닌 동/호는 SIP
 *       번호를 갖지 않는다. 그 단말은 인터폰 착신만 못 받고 WebRTC 초인종
 *       호출은 그대로 동작한다</li>
 * </ul>
 * 그래서 {@code sip} 가 없다고 등록을 실패로 다루면 안 된다.
 */
public class RegisterResult {

    public String title;
    public String result;
    /** {@code "approved"} 면 바로 쓸 수 있다. {@code "pending"} 이면 승인 대기다. */
    public String status;
    public String message;

    /** SIP 내선 자격. 승인된 단말에만, 번호가 있을 때만 실린다. */
    public SipCredential sip;

    /** mTLS 용 클라이언트 인증서 PEM. CSR 을 함께 보냈을 때만 실린다. */
    public String clientCert;

    public static RegisterResult fromJson(JSONObject json) {
        RegisterResult r = new RegisterResult();
        r.title = json.optString("title", null);
        r.result = json.optString("result", null);
        r.status = json.optString("status", null);
        r.message = json.optString("message", null);
        r.sip = SipCredential.fromJson(json.optJSONObject("sip"));
        r.clientCert = json.optString("clientCert", null);
        return r;
    }

    public boolean isSuccess() {
        return "success".equals(result);
    }

    /** 승인까지 끝나 SIP 로 등록할 수 있는 상태인가. */
    public boolean hasSipCredential() {
        return sip != null;
    }
}
