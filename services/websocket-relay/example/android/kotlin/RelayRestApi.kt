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
    private val baseUrl: String, // 예: https://jejezzhome.iptime.org:28099
) {
    /**
     * 단말을 등록한다. 같은 uuid 로 다시 부르면 갱신된다.
     *
     * token 은 FCM 등록 토큰이다. 착신 푸시가 이 값으로 간다.
     * 토큰은 앱 재설치·데이터 삭제·장기 미사용에 바뀌므로,
     * FirebaseMessagingService.onNewToken 에서 다시 등록해야 한다.
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
