package com.ptype.rtcrelay

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * IoT 제어 채널.
 *
 * RTC 와 다른 경로(/iot)와 다른 메시지 형태를 쓴다. 서버의 IoTMessage 와 맞춘다.
 *
 *   { "method":"create", "roomid":"1234", "clientid":0,
 *     "address":"101B1001U", "rescode":"0", "payload":{} }
 *
 * 알려진 문제: 성공 응답이 서버의 sendOk() 를 거치면서 "I don't know what to do with:"
 * 접두사가 붙어 나온다. 아래 parse() 가 접두사가 있든 없든 처리한다.
 */
class IotRelayClient(
    private val http: OkHttpClient,
    private val baseWsUrl: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        /** rescode "200" 이면 성공이다. */
        fun onResponse(method: String, roomId: String, clientId: Int, resCode: String, payload: Any?)
        fun onServerError(reason: String)
        fun onClosed(code: Int, reason: String)
        fun onFailure(t: Throwable)
    }

    private var socket: WebSocket? = null

    @Volatile var clientId: Int = 0
        private set

    fun connect() {
        val request = Request.Builder().url("$baseWsUrl/iot").build()
        socket = http.newWebSocket(request, SocketListener())
    }

    fun close() {
        socket?.close(1000, "bye")
        socket = null
    }

    /** 방을 만든다. 이미 있으면 같은 clientid 일 때만 다시 붙는다. */
    fun create(roomId: String, address: String, payload: Any? = null) =
        send("create", roomId, address, payload)

    /** create 와 같은 처리다. 등록 정보를 갱신할 때 쓴다. */
    fun modify(roomId: String, address: String, payload: Any? = null) =
        send("modify", roomId, address, payload)

    fun join(roomId: String, address: String) = send("join", roomId, address, null)
    fun subscribe(roomId: String, address: String) = send("subscribe", roomId, address, null)
    fun unsubscribe(roomId: String, address: String) = send("unsubscribe", roomId, address, null)

    /** 장치 제어 명령. payload 형식은 장치가 정한다. */
    fun control(roomId: String, address: String, payload: Any) =
        send("iot-control", roomId, address, payload)

    /** 상태 조회. 응답이 비동기로 온다. */
    fun status(roomId: String, address: String) = send("iot-status", roomId, address, null)

    private fun send(method: String, roomId: String, address: String, payload: Any?) {
        val ws = socket
        if (ws == null) {
            listener.onFailure(IllegalStateException("연결되어 있지 않습니다"))
            return
        }
        val json = JSONObject().apply {
            put("method", method)
            put("roomid", roomId)
            put("clientid", clientId)
            put("address", address)
            put("rescode", "0")
            put("payload", payload ?: JSONObject.NULL)
        }
        ws.send(json.toString())
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

        override fun onMessage(webSocket: WebSocket, text: String) = parse(text)

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            clientId = 0
            listener.onClosed(code, reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            clientId = 0
            listener.onFailure(t)
        }
    }

    private fun parse(text: String) {
        if (text.startsWith("ERROR:")) {
            listener.onServerError(text.removePrefix("ERROR:").trim())
            return
        }

        // 성공 응답에 붙어 나오는 접두사를 떼어낸다 (서버 sendOk 의 부작용)
        val body = text.removePrefix("I don't know what to do with:")

        val json = try {
            JSONObject(body)
        } catch (e: Exception) {
            listener.onServerError("파싱 실패: $text")
            return
        }

        // 서버가 배정한 clientid 를 보관한다. 이후 요청에 실어야 같은 세션으로 인식된다.
        val assigned = json.optInt("clientid", 0)
        if (assigned != 0) clientId = assigned

        listener.onResponse(
            method = json.optString("method"),
            roomId = json.optString("roomid"),
            clientId = assigned,
            resCode = json.optString("rescode"),
            payload = if (json.isNull("payload")) null else json.opt("payload"),
        )
    }
}
