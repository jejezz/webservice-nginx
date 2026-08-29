package com.ptype.rtcrelay

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * REST 호출.
 *
 * 모두 동기 호출이다. Android 메인 스레드에서 부르면 NetworkOnMainThreadException 이
 * 난다 — 코루틴(Dispatchers.IO)이나 별도 스레드에서 부를 것.
 */
class RelayRestApi(
    private val http: OkHttpClient,
    baseUrl: String, // 예: https://c-a3f19c04.rtc.zoomon.art  (디렉터리의 host 에 스킴을 붙인 것)
) {
    /**
     * 스킴이 없으면 https 로 본다.
     *
     * Firestore 디렉터리의 `host` 는 스킴 없는 호스트 이름이다
     * ("c-a3f19c04.rtc.example.com"). 그대로 넘기면 OkHttp 가
     * "Expected URL scheme 'http' or 'https'" 로 던진다.
     */
    private val baseUrl: String =
        if (baseUrl.contains("://")) baseUrl else "https://$baseUrl"

    /**
     * 단말을 등록한다. 같은 uuid 로 다시 부르면 갱신된다.
     *
     * token 은 FCM 등록 토큰이다. 착신 푸시가 이 값으로 간다.
     * 토큰은 앱 재설치·데이터 삭제·장기 미사용에 바뀌므로,
     * FirebaseMessagingService.onNewToken 에서 다시 등록해야 한다.
     *
     * **응답의 `sip` 로 SIP 내선 자격이 온다** (승인된 단말만). 그 값으로 Janus
     * 에 등록한다 — [sipCredential] 로 꺼내면 된다. 번호를 앱이 정하던 구조는
     * 없어졌으므로 `sip_user` 는 보내지 않는다 (docs/client-migration.md).
     *
     * ⚠️ **token 을 빈 값으로 부르지 말 것.** 저장된 토큰을 덮어쓰므로 그 단말의
     * 착신 푸시가 조용히 끊긴다.
     */
    fun registerMobile(
        uuid: String, email: String, complex: String, address: String,
        token: String, phone: String? = null, image: String? = null,
    ): JSONObject = postJson("/register/mobile", JSONObject().apply {
        put("uuid", uuid)
        put("email", email)
        put("complex", complex)
        put("address", address)
        put("token", token)
        phone?.let { put("phone", it) }
        image?.let { put("image", it) }
    })

    /**
     * 등록 응답에서 SIP 자격을 꺼낸다. 없으면 null.
     *
     * 없는 것은 오류가 아니다 — 아직 승인 전이거나(`status`가 `pending`),
     * `A동` 처럼 숫자가 아닌 동/호라 번호를 만들 수 없는 세대다. 그 단말은
     * 인터폰 착신만 못 받고 WebRTC 초인종 호출은 그대로 동작한다.
     *
     * **비밀번호는 바뀔 수 있다.** 그 자리를 다른 단말이 물려받으면 새로
     * 발급되므로, 등록이 401 이면 캐시한 값을 다시 쓰지 말고 registerMobile 을
     * 한 번 더 불러 새 값을 받는다.
     */
    fun sipCredential(response: JSONObject): SipCredential? {
        val sip = response.optJSONObject("sip") ?: return null
        val user = sip.optString("user").takeIf { it.isNotEmpty() } ?: return null
        val password = sip.optString("password").takeIf { it.isNotEmpty() } ?: return null
        return SipCredential(user, sip.optString("domain"), password)
    }

    /** 등록을 지운다. 이 뒤로는 착신 푸시가 오지 않는다. */
    fun unregisterMobile(uuid: String): JSONObject =
        postJson("/unregister/mobile", JSONObject().put("uuid", uuid))

    /** 홈넷 장치 등록. (단지, 동, 호) 조합이 신원이라 같은 조합이면 갱신된다. */
    fun registerHomenet(
        complex: String, type: String, building: String, unit: String, ipaddress: String,
    ): JSONObject = postJson("/register/complex_agents", JSONObject().apply {
        put("complex", complex)
        put("type", type)
        put("building", building)
        put("unit", unit)
        put("ipaddress", ipaddress)
    })

    /**
     * 접속 중인 상대의 IP 를 찾는다. 지금 방에 들어와 있는 클라이언트만 찾는다.
     * address 는 rtc:<주소>@<호스트> 형식이며 접두사와 @ 뒤는 서버가 떼어낸다.
     */
    fun findIp(address: String): JSONObject =
        getJson("/register/findip?address=" + java.net.URLEncoder.encode(address, "UTF-8"))

    /**
     * 착신 단말에 통화 요청 푸시를 보낸다.
     *
     * 주의: 서버가 방 번호를 만들어 푸시에만 싣고 응답 본문에는 넣지 않는다.
     * 발신 쪽은 이 호출의 응답에서 방 번호를 알 수 없다.
     */
    fun roomInvite(target: String, source: String): String =
        postRaw("/room/invite", JSONObject().apply {
            put("target", target)
            put("source", source)
        })

    /** 활성 방과 접속 클라이언트 목록. */
    fun statusRooms(): JSONObject = getJson("/status/rooms")

    // ---- 내부 ----

    private fun postJson(path: String, body: JSONObject): JSONObject =
        JSONObject(postRaw(path, body))

    private fun postRaw(path: String, body: JSONObject): String {
        val request = Request.Builder()
            .url(baseUrl + path)
            .post(body.toString().toRequestBody(JSON))
            .build()
        return execute(request)
    }

    private fun getJson(path: String): JSONObject =
        JSONObject(execute(Request.Builder().url(baseUrl + path).get().build()))

    private fun execute(request: Request): String =
        http.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                // 서버는 실패를 JSON({"error":...}) 또는 평문으로 준다. 원문을 그대로 실어 던진다.
                throw IOException("HTTP ${res.code} ${request.url.encodedPath}: $text")
            }
            text
        }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

/**
 * SIP 내선 자격. 서버가 승인 시점에 배정한다 (동4+호4+순번2 —
 * 101동 805호 1번이면 `0101080501`). 규격은 docs/identity.md.
 *
 * Janus SIP 플러그인에 넘길 때 `username` 과 `authuser` 는 **같은 계정**이어야
 * 한다. Kamailio 가 "digest 사용자명 == To 사용자명" 을 강제하므로 다르면 401 이다.
 *
 *     put("username", cred.sipUri)   // sip:0101080501@pluto.org
 *     put("authuser", cred.user)     // 0101080501
 *     put("secret",   cred.password)
 */
data class SipCredential(
    val user: String,
    val domain: String,
    val password: String,
) {
    val sipUri: String get() = "sip:$user@$domain"
}
