package com.ptype.rtcrelay

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject

/**
 * RTC 시그널링 클라이언트.
 *
 *   val client = RtcRelayClient(http, "wss://jejezzhome.iptime.org:28099", listener)
 *   client.connect()
 *   client.invite(roomId = "12345678",
 *                 sender   = RtcMessage.address("101B405U", "192.168.0.157"),
 *                 receiver = RtcMessage.address("101B203U", "192.168.0.167:8088"),
 *                 device   = "interphone")
 *   // onClientId 가 오면 그때부터 offer/answer/candidate 를 보낼 수 있다
 *
 * 스레드: OkHttp 가 자기 스레드에서 콜백을 부른다. UI 를 만지려면 넘겨받는 쪽에서
 * 메인 스레드로 옮겨야 한다.
 */
class RtcRelayClient(
    private val http: OkHttpClient,
    private val baseWsUrl: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onEvent(event: ServerEvent)
        fun onClosed(code: Int, reason: String)
        fun onFailure(t: Throwable)
    }

    private var socket: WebSocket? = null

    /** invite 응답으로 서버가 준 값. 이후 모든 메시지에 실어야 중계된다. */
    @Volatile var clientId: String = ""
        private set

    private var roomId: String = ""
    private var sender: String = ""
    private var receiver: String = ""
    private var device: String = ""

    fun connect() {
        // 경로는 반드시 /ws 다. 다른 경로면 서버가 이유 없이 닫는다.
        val request = Request.Builder().url("$baseWsUrl/ws").build()
        socket = http.newWebSocket(request, SocketListener())
    }

    fun close() {
        socket?.close(1000, "bye")
        socket = null
    }

    /**
     * 방에 들어간다. 첫 참가자면 서버가 receiver 주소의 단말에 FCM 푸시를 보낸다.
     * 응답으로 clientid 가 오며, 그 전에 보낸 시그널링은 중계되지 않는다.
     */
    fun invite(roomId: String, sender: String, receiver: String, device: String, code: String = "100") {
        this.roomId = roomId
        this.sender = sender
        this.receiver = receiver
        this.device = device
        send(RtcMessage("invite", roomId, sender, receiver, device, code = code))
    }

    /** 푸시를 받고 들어갈 때 쓴다. 착신 쪽 경로다. */
    fun inviteAck(push: RtcMessage) {
        this.roomId = push.roomid
        // 푸시의 sender/receiver 는 발신자 기준이므로 뒤집어 쓴다
        this.sender = push.receiver
        this.receiver = push.sender
        this.device = push.device
        send(RtcMessage("invite-ack", roomId, sender, receiver, device, code = push.code))
    }

    fun offer(sdp: String) = relay("offer", sdp)
    fun answer(sdp: String) = relay("answer", sdp)
    fun accept() = relay("accept", "")
    fun candidate(candidateJson: String) = relay("candidate", candidateJson)
    fun removeCandidates() = relay("remove-candidates", "")

    /** 통화 종료. 서버가 방에서 빼낸 뒤 상대에게 중계한다. */
    fun bye() = relay("bye", "")

    /**
     * SDP·ICE 는 extendParam 에 실어 보낸다.
     * 서버는 이 필드를 들여다보지 않고 원본 그대로 상대에게 넘긴다.
     */
    private fun relay(method: String, payload: String) {
        if (clientId.isEmpty()) {
            listener.onEvent(ServerEvent.Unknown("clientid 가 아직 없습니다. invite 응답을 기다리세요."))
            return
        }
        send(RtcMessage(method, roomId, sender, receiver, device, clientid = clientId, extendParam = payload))
    }

    private fun send(msg: RtcMessage) {
        val ws = socket
        if (ws == null) {
            listener.onFailure(IllegalStateException("연결되어 있지 않습니다"))
            return
        }
        ws.send(msg.toJson())
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

        override fun onMessage(webSocket: WebSocket, text: String) {
            listener.onEvent(parse(text))
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            listener.onEvent(parse(bytes.utf8()))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            clientId = ""
            listener.onClosed(code, reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            clientId = ""
            listener.onFailure(t)
        }
    }

    /**
     * 서버가 보내는 세 가지를 구분한다.
     *
     *   {"method":"update","clientid":"..."}   invite 응답 (JSON)
     *   {...}                                  중계된 시그널링 (JSON)
     *   ERROR:<사유>                           평문. 직후 연결이 닫힌다
     *   I don't know what to do with:<원본>    평문. 보낸 형식이 틀렸다는 뜻
     */
    private fun parse(text: String): ServerEvent {
        if (text.startsWith(PREFIX_ERROR)) {
            return ServerEvent.ServerError(text.removePrefix(PREFIX_ERROR).trim())
        }
        if (text.startsWith(PREFIX_UNPARSED)) {
            return ServerEvent.NotUnderstood(text.removePrefix(PREFIX_UNPARSED))
        }

        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            return ServerEvent.Unknown(text)
        }

        if (json.optString("method") == "update" && json.has("clientid")) {
            clientId = json.optString("clientid")
            return ServerEvent.ClientIdAssigned(clientId)
        }

        return ServerEvent.Signal(RtcMessage.fromJson(json), json)
    }

    private companion object {
        const val PREFIX_ERROR = "ERROR:"
        const val PREFIX_UNPARSED = "I don't know what to do with:"
    }
}
