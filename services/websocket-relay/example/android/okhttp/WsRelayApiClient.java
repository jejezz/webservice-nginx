package com.wsrelay.api;

import com.wsrelay.api.models.ApiCallback;
import com.wsrelay.api.models.ApiException;
import com.wsrelay.api.models.ErrorResponse;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Android client for the websocket-relay REST API.
 *
 * There is no login here. The relay's public endpoints are unauthenticated —
 * a device identifies itself by the uuid it registers with. (The management
 * APIs, /status and /mobile-crud-operation, are restricted to the LAN by the
 * server and are not exposed by this client.)
 *
 * Base URL is the nginx front door, so every path below sits under /relay:
 *   https://relay.example.com   ->  https://relay.example.com/relay/register/mobile
 *
 * Usage (sync — never on the main thread):
 *   WsRelayApiClient client = new WsRelayApiClient("https://relay.example.com");
 *   JSONObject raw = client.register().mobile(uuid, email, "행복단지", "101B203U", fcmToken);
 *   RegisterResult result = ResponseParser.registerResult(raw);
 *
 * Usage (async):
 *   client.register().mobileAsync(uuid, email, complex, address, fcmToken,
 *       new ApiCallback<JSONObject>() {
 *           public void onSuccess(JSONObject result) { ... }
 *           public void onError(ApiException e) { ... }
 *       });
 */
public class WsRelayApiClient {

    private static final MediaType JSON_TYPE = MediaType.get("application/json; charset=utf-8");

    /** Everything the relay serves is mounted under this prefix by nginx. */
    private static final String PREFIX = "/relay";

    private final String baseUrl;
    private final OkHttpClient httpClient;
    private final Executor callbackExecutor;
    private int maxRetries = 2;

    // ──────────────────────────────────────────────
    // Construction
    // ──────────────────────────────────────────────

    public WsRelayApiClient(String baseUrl) {
        this(baseUrl, null);
    }

    /**
     * @param customClient share your app's OkHttpClient (connection pool, SSL
     *                     pinning, logging interceptors) instead of a new one.
     */
    public WsRelayApiClient(String baseUrl, OkHttpClient customClient) {
        String trimmed = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        // Tolerate callers who already included /relay.
        this.baseUrl = trimmed.endsWith(PREFIX) ? trimmed.substring(0, trimmed.length() - PREFIX.length()) : trimmed;

        this.httpClient = customClient != null
                ? customClient
                : new OkHttpClient.Builder()
                        .connectTimeout(15, TimeUnit.SECONDS)
                        .readTimeout(30, TimeUnit.SECONDS)
                        .writeTimeout(30, TimeUnit.SECONDS)
                        .build();

        this.callbackExecutor = Executors.newSingleThreadExecutor();
    }

    // ──────────────────────────────────────────────
    // Configuration
    // ──────────────────────────────────────────────

    public void setMaxRetries(int maxRetries) { this.maxRetries = Math.max(0, maxRetries); }
    public OkHttpClient getHttpClient() { return httpClient; }

    public void shutdown() {
        httpClient.dispatcher().executorService().shutdown();
        httpClient.connectionPool().evictAll();
    }

    // ──────────────────────────────────────────────
    // Sub-API accessors
    // ──────────────────────────────────────────────

    public RegisterApi register() { return new RegisterApi(); }
    public UnregisterApi unregister() { return new UnregisterApi(); }
    public RoomApi room() { return new RoomApi(); }

    // ──────────────────────────────────────────────
    // Health
    // ──────────────────────────────────────────────

    /**
     * GET /relay/health
     *
     * Answers 200 even when the relay is degraded, so check the "status" field
     * rather than the HTTP code. See RelayHealth.
     */
    public JSONObject health() throws ApiException {
        return execute(new Request.Builder().url(url("/health")).get().build());
    }

    public void healthAsync(ApiCallback<JSONObject> callback) {
        async(this::health, callback);
    }

    // ──────────────────────────────────────────────
    // Register
    // ──────────────────────────────────────────────

    public class RegisterApi {

        /**
         * POST /relay/register/mobile — register this phone for doorbell push.
         *
         * Call it after every FCM token refresh, not just at first install:
         * the relay keys on uuid and overwrites the stored token, so re-posting
         * is the update path. There is no separate "update token" endpoint.
         *
         * @param uuid    stable per-install id; the primary key on the server
         * @param email   account this device belongs to (used by targeted push)
         * @param complex apartment complex name
         * @param address unit address, e.g. "101B203U" — must match what the
         *                door station will call, or the push never arrives
         * @param token   current FCM registration token
         */
        public JSONObject mobile(String uuid, String email, String complex, String address, String token)
                throws ApiException {
            JSONObject body = new JSONObject();
            try {
                body.put("uuid", uuid);
                body.put("email", email);
                body.put("complex", complex);
                body.put("address", address);
                body.put("token", token);
            } catch (JSONException e) {
                throw ApiException.builder().kind(ApiException.Kind.PARSE).cause(e).build();
            }
            return execute(post("/register/mobile", body));
        }

        public void mobileAsync(String uuid, String email, String complex, String address, String token,
                                ApiCallback<JSONObject> callback) {
            async(() -> mobile(uuid, email, complex, address, token), callback);
        }

        /**
         * POST /relay/register/complex_agents — register a home network unit
         * (wall pad). Keyed on (complex, building, unit); re-posting updates
         * the type and IP address.
         */
        public JSONObject homenet(String complex, String building, String unit, String type, String ipaddress)
                throws ApiException {
            JSONObject body = new JSONObject();
            try {
                body.put("complex", complex);
                body.put("building", building);
                body.put("unit", unit);
                body.put("type", type == null ? "" : type);
                body.put("ipaddress", ipaddress == null ? "" : ipaddress);
            } catch (JSONException e) {
                throw ApiException.builder().kind(ApiException.Kind.PARSE).cause(e).build();
            }
            return execute(post("/register/complex_agents", body));
        }

        public void homenetAsync(String complex, String building, String unit, String type, String ipaddress,
                                 ApiCallback<JSONObject> callback) {
            async(() -> homenet(complex, building, unit, type, ipaddress), callback);
        }

        /**
         * GET /relay/register/findip?address=… — current IP of a connected device.
         *
         * Walks live WebSocket connections, so it only finds devices that are
         * online right now. Accepts a bare address ("101B203U") or a prefixed
         * one ("rtc:101B203U@host") — the server strips the prefix and suffix.
         *
         * Returns 401 with a plain-text body when the device is not connected,
         * which surfaces here as ApiException with kind VALIDATION.
         */
        public JSONObject findIp(String address) throws ApiException {
            HttpUrl url = HttpUrl.parse(url("/register/findip"))
                    .newBuilder()
                    .addQueryParameter("address", address)
                    .build();
            return execute(new Request.Builder().url(url).get().build());
        }

        public void findIpAsync(String address, ApiCallback<JSONObject> callback) {
            async(() -> findIp(address), callback);
        }
    }

    // ──────────────────────────────────────────────
    // Unregister
    // ──────────────────────────────────────────────

    public class UnregisterApi {

        /**
         * POST /relay/unregister/mobile — stop push to this device.
         *
         * Call it on logout or account switch. Deletes the row outright, so the
         * device must register again to receive anything.
         *
         * Answers 404 when the uuid was not registered; that is not an error
         * worth surfacing to the user, so check kind == NOT_FOUND.
         */
        public JSONObject mobile(String uuid) throws ApiException {
            JSONObject body = new JSONObject();
            try {
                body.put("uuid", uuid);
            } catch (JSONException e) {
                throw ApiException.builder().kind(ApiException.Kind.PARSE).cause(e).build();
            }
            return execute(post("/unregister/mobile", body));
        }

        public void mobileAsync(String uuid, ApiCallback<JSONObject> callback) {
            async(() -> mobile(uuid), callback);
        }
    }

    // ──────────────────────────────────────────────
    // Room
    // ──────────────────────────────────────────────

    public class RoomApi {

        /**
         * POST /relay/room/invite — ring a unit.
         *
         * This is the door station's call, not the phone's: the relay makes a
         * room id, finds every active device registered at {target}, and pushes
         * an invite to them. The room id is not returned in the HTTP reply —
         * it arrives in the push (InviteNotification.roomId).
         *
         * Answers 200 on success, 400 when target is missing, 401 when source is.
         */
        public JSONObject invite(String target, String source) throws ApiException {
            JSONObject body = new JSONObject();
            try {
                body.put("target", target);
                body.put("source", source);
            } catch (JSONException e) {
                throw ApiException.builder().kind(ApiException.Kind.PARSE).cause(e).build();
            }
            return execute(post("/room/invite", body));
        }

        public void inviteAsync(String target, String source, ApiCallback<JSONObject> callback) {
            async(() -> invite(target, source), callback);
        }
    }

    // ──────────────────────────────────────────────
    // Async plumbing
    // ──────────────────────────────────────────────

    public interface Call<T> {
        T run() throws ApiException;
    }

    /** Run a sync call off the main thread and hand the result to the callback. */
    public <T> void async(Call<T> call, ApiCallback<T> callback) {
        callback.onStart();
        callbackExecutor.execute(() -> {
            try {
                T result = call.run();
                callback.onSuccess(result);
            } catch (ApiException e) {
                callback.onError(e);
            } catch (Exception e) {
                callback.onError(ApiException.builder()
                        .kind(ApiException.Kind.UNKNOWN).cause(e).build());
            } finally {
                callback.onComplete();
            }
        });
    }

    // ──────────────────────────────────────────────
    // HTTP
    // ──────────────────────────────────────────────

    private String url(String path) {
        return baseUrl + PREFIX + path;
    }

    private Request post(String path, JSONObject body) {
        return new Request.Builder()
                .url(url(path))
                .post(RequestBody.create(body.toString(), JSON_TYPE))
                .build();
    }

    /**
     * Send a request, retrying transient failures with a short backoff.
     *
     * Only retries when ApiException says it is safe — network trouble, 429,
     * or 5xx. Every endpoint this client calls is idempotent (register and
     * unregister are upserts and deletes), so a retry cannot double-book.
     */
    private JSONObject execute(Request request) throws ApiException {
        ApiException last = null;

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                try {
                    Thread.sleep(300L * attempt);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }

            try {
                return send(request);
            } catch (ApiException e) {
                last = e;
                if (!e.isRetryable()) throw e;
            }
        }

        throw last != null ? last : ApiException.builder().kind(ApiException.Kind.UNKNOWN).build();
    }

    private JSONObject send(Request request) throws ApiException {
        String method = request.method();
        String url = request.url().toString();

        try (Response response = httpClient.newCall(request).execute()) {
            ResponseBody responseBody = response.body();
            String text = responseBody != null ? responseBody.string() : "";

            if (!response.isSuccessful()) {
                throw ApiException.builder()
                        .fromStatus(response.code())
                        .serverMessage(serverMessageOf(text))
                        .request(method, url)
                        .build();
            }

            if (text.isEmpty()) return new JSONObject();

            try {
                return new JSONObject(text);
            } catch (JSONException e) {
                // Some endpoints answer with a bare string ("this is de-registration
                // module", or a plain sendStatus body). Hand it back rather than failing.
                try {
                    return new JSONObject().put("message", text);
                } catch (JSONException ignored) {
                    throw ApiException.builder()
                            .kind(ApiException.Kind.PARSE)
                            .request(method, url)
                            .cause(e)
                            .build();
                }
            }
        } catch (IOException e) {
            throw ApiException.builder()
                    .kind(ApiException.Kind.NETWORK)
                    .request(method, url)
                    .cause(e)
                    .build();
        }
    }

    /** Pull a human-readable message out of an error body, whatever shape it is. */
    private static String serverMessageOf(String text) {
        if (text == null || text.isEmpty()) return null;
        try {
            ErrorResponse parsed = ErrorResponse.fromJson(new JSONObject(text));
            String best = parsed.bestMessage();
            return best != null ? best : text;
        } catch (JSONException e) {
            return text;
        }
    }
}
