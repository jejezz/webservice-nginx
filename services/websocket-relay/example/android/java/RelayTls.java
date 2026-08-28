package com.ptype.rtcrelay;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.annotation.RawRes;
import okhttp3.OkHttpClient;
import java.io.InputStream;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * 서버 CA 만 신뢰하는 OkHttpClient 를 만든다.
 *
 * 서버는 사설 CA(DevCA Root)가 서명한 인증서를 쓴다. 단말 기본 신뢰 저장소에는
 * 없으므로 앱이 CA 를 들고 있어야 한다.
 *
 * 준비: nginx/cert/ca/ca.crt 를 app/src/main/res/raw/ca.crt 로 넣는다.
 *
 * 검증을 끄는 코드(모든 인증서 허용)는 넣지 않았다. 그렇게 하면 사설 CA 를 쓰는
 * 의미가 사라지고 중간자 공격을 그대로 받는다.
 */
public final class RelayTls {

    private RelayTls() { }

    @NonNull
    public static OkHttpClient client(@NonNull Context context, @RawRes int caResId) throws Exception {
        Certificate ca;
        try (InputStream in = context.getResources().openRawResource(caResId)) {
            ca = CertificateFactory.getInstance("X.509").generateCertificate(in);
        }

        // CA 하나만 담은 신뢰 저장소
        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        keyStore.load(null, null);
        keyStore.setCertificateEntry("relay-ca", ca);

        TrustManagerFactory tmf =
                TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(keyStore);

        X509TrustManager trustManager = null;
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) {
                trustManager = (X509TrustManager) tm;
                break;
            }
        }
        if (trustManager == null) throw new IllegalStateException("X509TrustManager 를 찾지 못했습니다");

        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(null, new TrustManager[] { trustManager }, null);

        return new OkHttpClient.Builder()
                .sslSocketFactory(sslContext.getSocketFactory(), trustManager)
                // 서버가 60초마다 ping 을 보낸다. 앱도 보내 두면 유휴 NAT 가 끊는 것을 막는다.
                .pingInterval(30, TimeUnit.SECONDS)
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket 은 무기한
                .build();
    }
}
