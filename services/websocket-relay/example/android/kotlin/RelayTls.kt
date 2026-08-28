package com.ptype.rtcrelay

import android.content.Context
import okhttp3.OkHttpClient
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

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
object RelayTls {

    fun client(context: Context, caResId: Int): OkHttpClient {
        val ca = context.resources.openRawResource(caResId).use { input ->
            CertificateFactory.getInstance("X.509").generateCertificate(input)
        }

        // CA 하나만 담은 신뢰 저장소
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("relay-ca", ca)
        }

        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(keyStore)
        }
        val trustManager = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager

        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), null)
        }

        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            // 서버가 60초마다 ping 을 보낸다. 앱도 보내 두면 유휴 NAT 가 끊는 것을 막는다.
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket 은 무기한
            .build()
    }
}
