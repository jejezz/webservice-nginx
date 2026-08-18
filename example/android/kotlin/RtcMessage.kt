package com.ptype.rtcrelay

import org.json.JSONObject

/**
 * RTC 시그널링 메시지.
 *
 * 서버의 ClientMessage(src/libs/clientMessage.ts)와 필드가 1:1로 맞는다.
 * roomid·sender·device·receiver 는 서버가 모든 메시지에서 검사하므로 비우면 안 된다.
 */
data class RtcMessage(
    val method: String,
    val roomid: String,
    val sender: String,
    val receiver: String,
    val device: String,
    val clientid: String = "",
    val code: String = "",
    val extendParam: String = "",
) {
    fun toJson(): String = JSONObject().apply {
        put("method", method)
        put("roomid", roomid)
        put("sender", sender)
        put("receiver", receiver)
        put("device", device)
        put("clientid", clientid)
        put("code", code)
        put("extendParam", extendParam)
    }.toString()

    companion object {
        /** 서버가 요구하는 주소 형식: rtc:<주소>@<호스트> */
        fun address(addr: String, host: String) = "rtc:$addr@$host"

        fun fromJson(json: JSONObject) = RtcMessage(
            method = json.optString("method"),
            roomid = json.optString("roomid"),
            sender = json.optString("sender"),
            receiver = json.optString("receiver"),
            device = json.optString("device"),
            clientid = json.optString("clientid"),
            code = json.optString("code"),
            extendParam = json.optString("extendParam"),
        )

        /**
         * FCM data 페이로드를 메시지로 옮긴다.
         *
         * 푸시는 roomId(대문자 I), WebSocket 규약은 roomid(소문자)를 쓴다.
         * 서버 쪽 철자가 갈려 있어 여기서 둘 다 받는다.
         */
        fun fromPushData(data: Map<String, String>) = RtcMessage(
            method = data["method"] ?: "invite",
            roomid = data["roomId"] ?: data["roomid"] ?: "",
            sender = data["sender"] ?: "",
            receiver = data["receiver"] ?: "",
            device = data["device"] ?: "",
            code = data["code"] ?: "",
        )
    }
}

/** 서버가 보내온 것을 종류별로 나눈 결과. */
sealed class ServerEvent {
    /** invite 응답. 이 clientid 를 이후 모든 메시지에 넣어야 한다. */
    data class ClientIdAssigned(val clientId: String) : ServerEvent()

    /** 방의 상대가 보낸 시그널링이 중계된 것. */
    data class Signal(val message: RtcMessage, val raw: JSONObject) : ServerEvent()

    /** 서버가 평문 "ERROR:..." 를 보낸 경우. 이 직후 연결이 닫힌다. */
    data class ServerError(val reason: String) : ServerEvent()

    /** 서버가 파싱하지 못한 입력에 응답한 것. 보낸 쪽 형식이 틀렸다는 뜻이다. */
    data class NotUnderstood(val echo: String) : ServerEvent()

    /** 위 어디에도 안 맞는 JSON. */
    data class Unknown(val raw: String) : ServerEvent()
}
