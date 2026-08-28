package com.wsrelay.api.models;

import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * The FCM push a phone receives when someone rings the doorbell.
 *
 * The relay sends it from two places — POST /relay/room/invite, and the
 * INVITE handler on /relay/rtc — with the same data fields:
 *
 *   method   "invite"
 *   sender   "rtc:{source}"     the caller (door station)
 *   receiver "rtc:{target}"     you
 *   code     "100"
 *   device   "interphone"
 *   roomId   8-digit room to join
 *
 * The notification block carries a Korean title/body, and the Android block
 * sets channelId "callfusion_2_rtc" with sound "doorbell.wav" — create that
 * channel at install time or the doorbell will be silent on Android 8+.
 *
 * Flow: receive this -> connect to /relay/rtc -> send INVITE with roomid=roomId.
 */
public class InviteNotification {

    public String method;
    public String sender;
    public String receiver;
    public String code;
    public String device;
    public String roomId;

    /** Notification channel the relay asks Android to use. Must exist before the first push. */
    public static final String CHANNEL_ID = "callfusion_2_rtc";
    public static final String SOUND = "doorbell.wav";

    public static InviteNotification fromData(Map<String, String> data) {
        InviteNotification n = new InviteNotification();
        n.method = data.get("method");
        n.sender = data.get("sender");
        n.receiver = data.get("receiver");
        n.code = data.get("code");
        n.device = data.get("device");
        n.roomId = data.get("roomId");
        return n;
    }

    /** Convenience for FirebaseMessagingService.onMessageReceived. */
    public static InviteNotification from(RemoteMessage message) {
        return fromData(message.getData());
    }

    public boolean isInvite() {
        return WsMethod.INVITE.equals(method);
    }

    /** Strip "rtc:" and any "@host" so it can be compared with a registered address. */
    public String senderAddress() { return plainAddress(sender); }
    public String receiverAddress() { return plainAddress(receiver); }

    static String plainAddress(String value) {
        if (value == null) return null;
        String s = value.startsWith("rtc:") ? value.substring(4)
                 : value.startsWith("iot:") ? value.substring(4)
                 : value;
        int at = s.indexOf('@');
        return at >= 0 ? s.substring(0, at) : s;
    }
}
