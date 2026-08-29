package com.wsrelay.api.models;

import org.json.JSONObject;

/**
 * SIP 내선 자격. 등록 응답의 {@code sip} 에 실려 온다.
 *
 * <pre>
 * { "user": "0101080501", "domain": "pluto.org", "password": "…" }
 * </pre>
 *
 * <h3>번호는 서버가 정한다</h3>
 * 앱이 {@code sip_user} 를 정해 보내던 구조는 없어졌다. 서버가 승인 시점에
 * 동/호에서 계산해 배정하고(동4+호4+순번2 — {@code 101동 805호 1번 → 0101080501})
 * Kamailio 계정까지 만든다. 규격은 {@code docs/identity.md} 에 있다.
 *
 * <h3>들고 있지 말고 그때그때 받는다</h3>
 * <b>비밀번호는 바뀔 수 있다.</b> 그 자리를 다른 단말이 물려받으면 새로 발급된다.
 * 등록이 401 로 실패하면 캐시한 값을 다시 쓰지 말고 {@code /register/mobile} 을
 * 한 번 더 불러 새 값을 받을 것.
 *
 * <h3>Janus 에 넘길 때</h3>
 * <pre>
 * body.put("username", cred.sipUri());   // sip:0101080501@pluto.org
 * body.put("authuser", cred.user);       // 0101080501
 * body.put("secret",   cred.password);
 * </pre>
 * {@code username} 과 {@code authuser} 는 <b>같은 계정을 가리켜야 한다.</b>
 * Kamailio 가 "digest 사용자명 == To 사용자명" 을 강제하므로 다르면 401 이다.
 */
public class SipCredential {

    /** 내선 번호 10자리. 이 단말의 SIP 신원이다. */
    public String user;
    /** SIP 도메인. kamctlrc 의 SIP_DOMAIN 과 같다. */
    public String domain;
    /** digest 비밀번호. 바뀔 수 있으므로 오래 들고 있지 않는다. */
    public String password;

    /** {@code sip} 객체가 없으면 null. 번호를 아직 못 받은 단말이다. */
    public static SipCredential fromJson(JSONObject json) {
        if (json == null) return null;
        SipCredential c = new SipCredential();
        c.user = json.optString("user", null);
        c.domain = json.optString("domain", null);
        c.password = json.optString("password", null);
        return (c.user == null || c.password == null) ? null : c;
    }

    /** Janus SIP 플러그인의 {@code username} 에 넣을 값. */
    public String sipUri() {
        return "sip:" + user + "@" + domain;
    }
}
