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
- `HTTPS_PORT` - HTTPS server port (default: 28090)
- `NODE_ENV` - Node.js environment (development/production/test)

### SSL/TLS Certificates
- `SSL_PRIVATE_KEY_PATH` - Path to SSL private key file
- `SSL_CERTIFICATE_PATH` - Path to SSL certificate file  
- `SSL_CA_PATH` - Path to Certificate Authority file
- `SSL_LONGLIVE_PRIVATE_KEY_PATH` - Alternative certificate private key
- `SSL_LONGLIVE_CERTIFICATE_PATH` - Alternative certificate file

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
HTTPS_PORT=28090
DEBUG_MODE=true
LOG_LEVEL=debug
```

### Production Environment
```bash
# .env
NODE_ENV=production
HTTPS_PORT=443
DEBUG_MODE=false
LOG_LEVEL=info
TRUST_PROXY=true
```

### Custom Certificate Paths
```bash
# .env
SSL_PRIVATE_KEY_PATH=/etc/ssl/private/callfusion.key
SSL_CERTIFICATE_PATH=/etc/ssl/certs/callfusion.crt
SSL_CA_PATH=/etc/ssl/certs/ca-bundle.crt
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