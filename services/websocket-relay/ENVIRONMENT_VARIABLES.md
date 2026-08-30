# Environment Variables Configuration

## Overview
The CallFusion WebRTC Server now supports environment variables for configuration management. This allows for flexible deployment across different environments without modifying the source code.

## Setup

### 1. Copy Environment File
```bash
cp .env.example .env
```

### 2. Edit Configuration
Modify the `.env` file with your specific configuration values:

```bash
nano .env
```

## Environment Variables Reference

### Server Configuration
- `PORT` - 듣는 포트 (기본 28099). 평문 HTTP 다 — TLS 는 nginx 가 443 에서 끊는다
- `BIND_ADDR` - 듣는 주소 (기본 `127.0.0.1`). 루프백 밖으로 열면 nginx 를 우회한
  직접 접근이 생기고, `/mobile-crud-operation` 의 사설망 허용 대역이 넓어진다
- `BASE_PATH` - nginx 접두사 (기본 `/relay`). `nginx-conf/service.ini` 의 `location`
  과 **같아야 한다**
- `NODE_ENV` - Node.js environment (development/production/test)

> `HTTPS_PORT` 는 평문 전환(2026-08-28) 전 이름입니다. 남아 있으면 `PORT` 대신
> 그대로 쓰이지만 경고가 뜹니다.

### SSL/TLS Certificates

**없습니다.** 이 서비스는 TLS 를 다루지 않습니다. 인증서는 `nginx/cert/` 가
소유하고 nginx 가 443 에서 씁니다 — `nginx/README.md` 참고.

### Database Configuration
- `SQLITE_DB_PATH` - SQLite database file path
- `MOBILE_TABLE_NAME` - Mobile devices table name
- `HOMENET_TABLE_NAME` - Home network devices table name

### Firebase Configuration
- `FIREBASE_SERVICE_ACCOUNT_PATH` - Path to Firebase Admin SDK JSON file

### Logging Configuration
- `LOG_LEVEL` - Log level (error/warn/info/debug). 기본값은 프로덕션 `info`, 그 외 `debug`.
  WebSocket 메시지 단위 로그는 `debug` 에 있다 — 시그널링 한 통화에 SDP 와 ICE
  candidate 수십 개가 오가므로 프로덕션에서 `debug` 를 켜면 로그 쓰기가 병목이 된다.
- `CONSOLE_LOGGING` - Enable console logging (true/false). 기본값은 프로덕션에서
  `false` (pm2 가 stdout 을 파일로 받으므로 아래 파일 로그와 중복된다), 그 외 `true`.

로그 파일은 `logs/` 에 날짜별로 쌓이고 20MB 마다 회전, 14일치만 남는다
(`application-%DATE%.log`, `error-%DATE%.log`). 회전 없이 무한히 자라던
`combined.log` 를 대체한 것이라, 남아 있는 옛 `logs/combined.log` 는 지워도 된다.

### WebSocket Configuration
- `WS_PING_INTERVAL` - WebSocket ping interval in milliseconds
- `WS_CONNECTION_TIMEOUT` - Connection timeout in milliseconds

### Security Configuration
- `ENABLE_CORS` - Enable CORS (true/false)
- `CORS_ORIGINS` - Allowed CORS origins (comma-separated)
- `MAX_REQUEST_SIZE` - Maximum request size in bytes

### Development Configuration
- `DEBUG_MODE` - Enable debug mode (true/false)
- `DEV_MIDDLEWARE` - Enable development middleware (true/false)
- `TRUST_PROXY` - Trust proxy headers (true/false)

### Janus 단말별 토큰 (docs/client-migration.md)
- `JANUS_TOKEN_AUTH` - 단말마다 다른 Janus 토큰을 발급할지 (기본 `false`).
  **Janus 쪽 `janus.jcfg` 의 `token_auth = true` 를 먼저 켜 두어야** 합니다 —
  순서가 뒤바뀌면 발급이 매번 490 으로 실패하고 앱은 계속 apisecret 으로 붙습니다
- `JANUS_ADMIN_URL` - Admin API 주소 (기본 `http://127.0.0.1:7088/admin`).
  **이 포트는 외부에 열지 않습니다** — 세션 조회·토큰 발급·강제 종료가 전부 되는 문입니다
- `JANUS_ADMIN_SECRET_FILE` - admin_secret 파일 (기본 `../janus/secrets/admin-secret`)
- `JANUS_TOKEN_PLUGINS` - 토큰이 열어 주는 플러그인 (기본 `janus.plugin.sip`).
  **비우지 마세요** — 그 Janus 에 올라간 모든 플러그인이 열립니다
- `JANUS_ADMIN_TIMEOUT` - Admin API 응답을 기다리는 밀리초 (기본 2000)

### SIP 내선 계정 (docs/identity.md)
- `SIP_PROVISION` - 승인된 단말에게 Kamailio 내선 계정을 만들어 줄지 (기본 `true`).
  끄면 번호는 배정하되 계정은 만들지 않는다 — Kamailio 가 없는 개발기용
- `SIP_DOMAIN` - 만들 계정의 도메인 (기본 `pluto.org`). **kamctlrc 의 `SIP_DOMAIN`
  과 같아야 한다** — 다르면 그 계정으로 등록되지 않는다
- `SIP_SUBSCRIBER_TABLE` - 계정이 사는 표 (기본 `kamailio.subscriber`). 같은
  MariaDB 의 다른 스키마라 풀을 더 만들지 않고 스키마를 붙여 쓴다

### Firebase Push Notifications
- `FCM_CHANNEL_ID` - Firebase notification channel ID
- `FCM_SOUND_FILE` - Notification sound file name
- `FCM_PRIORITY` - Message priority (high/normal)
- `FCM_TTL` - Message time to live in seconds

## Usage Examples

### Development Environment
```bash
# .env
NODE_ENV=development
PORT=28099
BIND_ADDR=127.0.0.1
DEBUG_MODE=true
LOG_LEVEL=debug
```

### Production Environment
```bash
# .env
NODE_ENV=production
PORT=28099
BIND_ADDR=127.0.0.1
DEBUG_MODE=false
LOG_LEVEL=info
TRUST_PROXY=true
```

### Custom Database Configuration
```bash
# .env
SQLITE_DB_PATH=/var/lib/callfusion/database.db
MOBILE_TABLE_NAME=mobile_devices
HOMENET_TABLE_NAME=home_devices
```

## Deployment

### Docker
Create a `.env` file and mount it to your container:
```bash
docker run -d --env-file .env -p 28090:28090 callfusion-server
```

### systemd Service
Set environment variables in your service file:
```ini
[Service]
EnvironmentFile=/etc/callfusion/.env
ExecStart=/usr/local/bin/node /opt/callfusion/index.js
```

### Process Manager (PM2)
Use ecosystem file with environment variables:
```javascript
module.exports = {
  apps: [{
    name: 'callfusion',
    script: './src/index.js',
    env_file: '.env'
  }]
}
```

## Security Considerations

1. **Never commit `.env` files** to version control
2. **Use strong, unique values** for production
3. **Restrict file permissions** on `.env` files:
   ```bash
   chmod 600 .env
   ```
4. **Use separate configurations** for different environments
5. **Regularly rotate sensitive values** like certificates and API keys

## Troubleshooting

### Environment Variables Not Loading
1. Ensure `.env` file is in the project root
2. Check file permissions and ownership
3. Verify no syntax errors in `.env` file
4. Restart the application after changes

### Certificate Path Issues
1. Use absolute paths for certificates in production
2. Ensure certificate files exist and are readable
3. Check certificate file permissions
4. Verify certificate validity and chain

### Database Connection Issues
1. Ensure database directory is writable
2. Check SQLite file permissions
3. Verify disk space availability
4. Test database path accessibility

## Best Practices

1. **Use `.env.example`** as a template for new deployments
2. **Document custom variables** in your deployment notes
3. **Test configurations** in staging before production
4. **Monitor application logs** for configuration warnings
5. **Keep backups** of working configurations
6. **Use configuration validation** in CI/CD pipelines

## Migration from Hardcoded Values

If migrating from previous versions:

1. Create `.env` file from `.env.example`
2. Set environment variables to match your current setup
3. Test the application in development
4. Deploy with confidence knowing defaults are maintained

The application will use sensible defaults if environment variables are not set, ensuring backward compatibility.