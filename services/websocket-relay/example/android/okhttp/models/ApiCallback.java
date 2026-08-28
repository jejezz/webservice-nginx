package com.wsrelay.api.models;

/**
 * Callback interface for async API calls.
 *
 * Usage:
 *   client.async(
 *       () -> client.register().mobile(uuid, email, complex, address, fcmToken),
 *       new ApiCallback<JSONObject>() {
 *           public void onSuccess(JSONObject result) { ... }
 *           public void onError(ApiException e) { ... }
 *       }
 *   );
 */
public interface ApiCallback<T> {

    void onSuccess(T result);

    void onError(ApiException error);

    /**
     * Optional: called on the calling thread before the request starts.
     * Override to show loading indicators, etc.
     */
    default void onStart() {}

    /**
     * Optional: called after either onSuccess or onError.
     * Override to hide loading indicators, etc.
     */
    default void onComplete() {}
}
