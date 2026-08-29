package com.ptype.rtcrelay;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;
import java.io.IOException;
import java.net.URLEncoder;

/**
 * REST 호출.
 *
 * 모두 동기 호출이다. Android 메인 스레드에서 부르면 NetworkOnMainThreadException 이
 * 난다 — 별도 스레드나 Executor 에서 부를 것.
 */
public final class RelayRestApi {

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private final OkHttpClient http;
    private final String baseUrl; // 예: https://jejezzhome.iptime.org:28099

    public RelayRestApi(@NonNull OkHttpClient http, @NonNull String baseUrl) {
        this.http = http;
        // 스킴이 없으면 https 로 본다. Firestore 디렉터리의 `host` 는 스킴 없는
        // 호스트 이름이라("c-a3f19c04.rtc.example.com") 그대로 넘기면 OkHttp 가
        // "Expected URL scheme 'http' or 'https'" 로 던진다.
        this.baseUrl = baseUrl.contains("://") ? baseUrl : "https://" + baseUrl;
    }

    /**
     * 단말을 등록한다. 같은 uuid 로 다시 부르면 갱신된다.
     *
     * token 은 FCM 등록 토큰이다. 착신 푸시가 이 값으로 간다.
     * 토큰은 앱 재설치·데이터 삭제·장기 미사용에 바뀌므로,
     * FirebaseMessagingService.onNewToken 에서 다시 등록해야 한다.
     */
    public JSONObject registerMobile(String uuid, String email, String complex, String address,
                                     String token, @Nullable String phone, @Nullable String image)
            throws IOException {
        JSONObject body = new JSONObject();
        try {
            body.put("uuid", uuid);
            body.put("email", email);
            body.put("complex", complex);
            body.put("address", address);
            body.put("token", token);
            if (phone != null) body.put("phone", phone);
            if (image != null) body.put("image", image);
        } catch (Exception e) {
            throw new IOException(e);
        }
        return postJson("/register/mobile", body);
    }

    /** 등록을 지운다. 이 뒤로는 착신 푸시가 오지 않는다. */
    public JSONObject unregisterMobile(String uuid) throws IOException {
        return postJson("/unregister/mobile", json("uuid", uuid));
    }

    /** 홈넷 장치 등록. (단지, 동, 호) 조합이 신원이라 같은 조합이면 갱신된다. */
    public JSONObject registerHomenet(String complex, String type, String building,
                                      String unit, String ipaddress) throws IOException {
        JSONObject body = new JSONObject();
        try {
            body.put("complex", complex);
            body.put("type", type);
            body.put("building", building);
            body.put("unit", unit);
            body.put("ipaddress", ipaddress);
        } catch (Exception e) {
            throw new IOException(e);
        }
        return postJson("/register/complex_agents", body);
    }

    /**
     * 접속 중인 상대의 IP 를 찾는다. 지금 방에 들어와 있는 클라이언트만 찾는다.
     * address 는 rtc:&lt;주소&gt;@&lt;호스트&gt; 형식이며 접두사와 @ 뒤는 서버가 떼어낸다.
     */
    public JSONObject findIp(String address) throws IOException {
        return getJson("/register/findip?address=" + URLEncoder.encode(address, "UTF-8"));
    }

    /**
     * 착신 단말에 통화 요청 푸시를 보낸다.
     *
     * 주의: 서버가 방 번호를 만들어 푸시에만 싣고 응답 본문에는 넣지 않는다.
     * 발신 쪽은 이 호출의 응답에서 방 번호를 알 수 없다.
     */
    public String roomInvite(String target, String source) throws IOException {
        JSONObject body = new JSONObject();
        try {
            body.put("target", target);
            body.put("source", source);
        } catch (Exception e) {
            throw new IOException(e);
        }
        return postRaw("/room/invite", body);
    }

    /** 활성 방과 접속 클라이언트 목록. */
    public JSONObject statusRooms() throws IOException {
        return getJson("/status/rooms");
    }

    // ---- 내부 ----

    private static JSONObject json(String k, String v) throws IOException {
        try {
            return new JSONObject().put(k, v);
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    private JSONObject postJson(String path, JSONObject body) throws IOException {
        return parse(postRaw(path, body));
    }

    private String postRaw(String path, JSONObject body) throws IOException {
        Request request = new Request.Builder()
                .url(baseUrl + path)
                .post(RequestBody.create(body.toString(), JSON))
                .build();
        return execute(request);
    }

    private JSONObject getJson(String path) throws IOException {
        return parse(execute(new Request.Builder().url(baseUrl + path).get().build()));
    }

    private String execute(Request request) throws IOException {
        try (Response res = http.newCall(request).execute()) {
            ResponseBody rb = res.body();
            String text = rb == null ? "" : rb.string();
            if (!res.isSuccessful()) {
                // 서버는 실패를 JSON({"error":...}) 또는 평문으로 준다. 원문을 그대로 실어 던진다.
                throw new IOException("HTTP " + res.code() + " " + request.url().encodedPath() + ": " + text);
            }
            return text;
        }
    }

    private static JSONObject parse(String text) throws IOException {
        try {
            return new JSONObject(text);
        } catch (Exception e) {
            throw new IOException("JSON 이 아닌 응답: " + text, e);
        }
    }
}
