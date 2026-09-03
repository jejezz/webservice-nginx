package com.wsrelay.api.models;

/**
 * Every "method" value the relay understands, and the ones it sends back.
 *
 * The relay switches on this string and silently ignores anything it does not
 * recognise (it logs "invalid message" server-side and sends nothing back), so
 * a typo here looks exactly like a dead connection. Use these constants.
 *
 * Source of truth: services/websocket-relay/src/ws/service.ts (WS_METHODS).
 */
public final class WsMethod {

    private WsMethod() {}

    // ── RTC signalling — sent on /relay/rtc ──────────────────────
    /** Join a room. Must be the first message; everything else is rejected until you do. */
    public static final String INVITE = "invite";
    /** Same as INVITE. Kept because existing devices send it. */
    public static final String INVITE_ACK = "invite-ack";
    public static final String OFFER = "offer";
    public static final String ANSWER = "answer";
    public static final String ACCEPT = "accept";
    public static final String CANDIDATE = "candidate";
    public static final String REMOVE_CANDIDATES = "remove-candidates";
    /** Leave the room. The relay removes you and forwards this to the peer. */
    public static final String BYE = "bye";
    public static final String ERROR = "error";

    // ── Sent by the server ──────────────────────────────────────
    /**
     * The relay's reply to INVITE: {"method":"update","clientid":"12345678"}.
     * Keep this clientid — every later message must carry it.
     */
    public static final String UPDATE = "update";

    // ── IoT — sent on /relay/iot ────────────────────────────────
    public static final String CREATE = "create";
    public static final String MODIFY = "modify";
    public static final String JOIN = "join";
    public static final String SUBSCRIBE = "subscribe";
    public static final String UNSUBSCRIBE = "unsubscribe";
    public static final String IOT_CONTROL = "iot-control";
    public static final String IOT_STATUS = "iot-status";
}
