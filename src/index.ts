/**
 * @file index.ts
 * @brief Main entry point for the CallFusion WebRTC Server
 * @author CallFusion Team
 * @date 2024
 * @version 1.0.0
 * 
 * @description
 * This file contains the main CallFusion server implementation that provides:
 * - HTTPS server with SSL/TLS encryption
 * - WebSocket service for real-time communication
 * - SQLite database for mobile device registration
 * - Express.js routing for REST API endpoints
 * - Certificate download service
 * 
 * The server supports both RTC (Real-Time Communication) and IoT device management
 * with comprehensive room-based client management and message routing.
 */

import dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env file

//import http from 'http';
import https from 'https';
import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express, { Application, Request, Response } from 'express';
import { RtcRoomTable } from './libs/rtcRoomTable.js';
import { startWebsocketService } from './libs/websocketService.js';
import Route2Register from './routes/register.js';
import Route2Room from './routes/room.js';
import Route2Unregister from './routes/unregister.js';
import Route2User from './routes/user.js';
import Route2Status from './routes/status.js';
import Route2Mobile from './routes/mobile.js';
import logger from './libs/logger.js'; // Import your configured logger
import { DbConn, DATABASE } from './libs/dbConnection.js';
import { requirePage } from './auth/session.js';
import { createDashboardApi } from './http/dashboardApi.js';

// ES module compatible __filename and __dirname
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.title = "rtc-relay-server";

/**
 * Nginx 가 이 서비스를 프록시할 때 쓰는 경로 접두사.
 * 단말은 포트(28099)로 직접 붙으므로 루트 경로도 함께 받는다.
 */
const BASE_PATH = process.env.BASE_PATH || '/rtc-relay';

/** 관리 대시보드 경로 (BASE_PATH 하위). manager 가 이 값으로 링크를 만든다. */
const DASHBOARD_PATH = process.env.DASHBOARD_PATH || '/dashboard';

/** 서비스 디렉토리 (src 의 상위). .env 의 상대 경로 기준점이다. */
const SERVICE_DIR = path.resolve(__dirname, '..');

/** 빌드된 대시보드 위치 — web/dist */
const DASHBOARD_DIR = path.resolve(__dirname, '..', 'web', 'dist');

/**
 * @brief Validates essential environment variables and provides warnings for missing optional ones
 * @details Checks for required configuration and logs helpful messages for optional settings
 */
function validateEnvironmentVariables(): void {
    const requiredVars = ['HTTPS_PORT'];
    const optionalVars = [
        'SSL_PRIVATE_KEY_PATH', 'SSL_CERTIFICATE_PATH', 'SSL_CA_PATH',
        'MOBILE_TABLE_NAME', 'HOMENET_TABLE_NAME', 'FIREBASE_SERVICE_ACCOUNT_PATH',
        'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD_FILE'
    ];

    // Check required variables
    const missingRequired = requiredVars.filter(varName => !process.env[varName]);
    if (missingRequired.length > 0) {
        logger.warn(`Missing required environment variables: ${missingRequired.join(', ')}`);
        logger.warn('Using default values. Consider setting these in your .env file.');
    }

    // Log optional variables status
    const missingOptional = optionalVars.filter(varName => !process.env[varName]);
    if (missingOptional.length > 0) {
        logger.info(`Using default values for: ${missingOptional.join(', ')}`);
    }

    // Log current configuration
    logger.info('Environment Configuration:');
    logger.info(`- HTTPS Port: ${process.env.HTTPS_PORT || '28090 (default)'}`);
    logger.info(`- Node Environment: ${process.env.NODE_ENV || 'development (default)'}`);
    logger.info(`- Database: ${DbConn.isConfigured() ? `${DATABASE.USER}@${DATABASE.HOST}:${DATABASE.PORT}/${DATABASE.NAME}` : '미설정 — 단말 등록 비활성'}`);
    logger.info(`- Mobile Table: ${process.env.MOBILE_TABLE_NAME || 'rtc_mobiles (default)'}`);
}

// Validate environment variables on startup
validateEnvironmentVariables();

/**
 * @brief Global error handlers for uncaught exceptions and unhandled promise rejections
 * @details These handlers are critical for debugging silent exits and ensuring
 * proper error logging before process termination.
 */

// --- Global Error Handlers (VERY IMPORTANT for debugging silent exits) ---
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:');
  console.error(err.stack);
  process.exit(1); // Exit with a failure code
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1); // Exit with a failure code
});

/**
 * @class CallFusion
 * @brief Main server class implementing the Singleton pattern for CallFusion WebRTC Server
 * 
 * @details
 * This class manages the entire server infrastructure including:
 * - HTTPS server with SSL/TLS encryption
 * - WebSocket service for real-time communication
 * - Express.js application with routing
 * - SQLite database for device registration
 * - Room-based client management
 * - Certificate download service
 * 
 * The class follows the Singleton pattern to ensure only one server instance
 * is running at any time.
 */
export class CallFusion {
    
    /** @brief Singleton instance of CallFusion server */
    private static instance: CallFusion | null = null;
    
    /**
     * @brief Gets the singleton instance of CallFusion server
     * @return CallFusion The singleton instance
     * @details Creates a new instance if none exists, otherwise returns the existing instance
     */
    public static getInstance(): CallFusion {
        if (this.instance === null) {
            this.instance = new CallFusion();
        }
        return this.instance;
    }
    /** @brief Main Express application instance for handling HTTP/HTTPS requests */
    public expressApp: express.Application;
    
    /** @brief HTTPS server instance with SSL/TLS encryption */
    public httpsServer: https.Server;
    
    /** @brief Room table managing all WebRTC rooms and client connections */
    public roomTable: RtcRoomTable; // timeout in milliseconds
    
    /** @brief Secret room number for private server access - not exposed publicly */
    private secretRoomNumber: number = 0;

    /** @brief 대시보드 빌드가 있는지. 기동 로그에 표시한다. */
    private hasDashboardBuild: boolean = false;
    
    // //public wsRtcServer: WebSocketServer;
    // //public wsRtcServer: WebSocketServer;
    
    /** 
     * @brief SQLite table name for mobile device registration
     * @details Can be configured via MOBILE_TABLE_NAME environment variable
     */
    public static tableForMobile: string = process.env.MOBILE_TABLE_NAME || "rtc_mobiles";
    
    /** 
     * @brief SQLite table name for home network device registration
     * @details Can be configured via HOMENET_TABLE_NAME environment variable
     */
    public static tableForHomenet: string = process.env.HOMENET_TABLE_NAME || "rtc_homenet";

    /**
     * @brief Gets the SQLite table name for mobile device registration
     * @return string The mobile device table name
     */
    public static getTableForMobile() : string {
        return this.tableForMobile;
    }

    /**
     * @brief Gets the SQLite table name for home network device registration  
     * @return string The home network device table name
     */
    public static getTableForHomenet() : string {
        return this.tableForHomenet;
    }
    
    /**
     * @brief Private constructor implementing Singleton pattern
     * @details Initializes the entire server infrastructure:
     * - Creates Express applications for main and download services
     * - Configures SSL/TLS certificates
     * - Sets up routing and middleware
     * - Initializes SQLite database
     * - Configures room table for client management
     * 
     * @throws Error if SSL/TLS certificate files are missing
     */
    private constructor() {
        this.expressApp = express();
        
          /**
         * @brief SSL/TLS certificate configuration with environment variable support
         * @details Loads certificate paths from environment variables with fallbacks
         */
        // 인증서는 이 서비스가 소유하지 않는다. 프로젝트의 nginx/cert/ 를 그대로 쓴다
        // (nginx/README.md 의 규칙, 경로는 .env 가 정한다).
        // 상대 경로는 서비스 디렉토리 기준으로 푼다 — cwd 에 기대지 않는다.
        const resolveCert = (p: string) => (path.isAbsolute(p) ? p : path.resolve(SERVICE_DIR, p));
        const privateKey = resolveCert(process.env.SSL_PRIVATE_KEY_PATH || '../../nginx/cert/server/server.key');
        const certificate = resolveCert(process.env.SSL_CERTIFICATE_PATH || '../../nginx/cert/server/server.crt');
        const ca = resolveCert(process.env.SSL_CA_PATH || '../../nginx/cert/ca/ca.crt');

        // Check if certificate files exist
        if (!fs.existsSync(privateKey) || !fs.existsSync(certificate) || !fs.existsSync(ca)) {
            logger.error('SSL/TLS certificate files not found.');
            logger.error(`Certificate paths: key=${privateKey}, cert=${certificate}, ca=${ca}`);
            logger.error(`Please ensure certificate files exist or update environment variables.`);
            logger.error('인증서는 nginx/cert/ 가 소유합니다 — nginx/README.md 참고');
            process.exit(1); // Exit if certs are missing
        }

        const httpsOptions = {
            key: fs.readFileSync(privateKey),
            cert: fs.readFileSync(certificate),
            ca: fs.readFileSync(ca) // Include the intemediate CA
        };
        //this.httpServer = http.createServer(this.expressApp);
        this.roomTable = new RtcRoomTable(1000); // timeout in milliseconds
        this.expressApp.set('strict routing', true);
        this.expressApp.set('case sensitive routing', true);
        // set this 
        this.expressApp.set('callFusion', this);

        /**
         * @brief Health check endpoint
         * @details 관리 대시보드(nginx/manager)가 서비스 상태를 판정하는 데 사용한다.
         * 프로젝트의 모든 서비스가 동일한 형태로 응답해야 한다.
         */
        this.expressApp.get('/health', async (req: Request, res: Response) => {
            // DB 는 단말 등록에만 필요하고 시그널링 본연의 기능과는 무관하다.
            // 끊겨도 status 는 ok 로 두되, details 로 상태를 드러내 대시보드에서 확인할 수 있게 한다.
            const database = await DbConn.ping();

            res.status(200).json({
                service: 'rtc-relay-server',
                status: 'ok',
                uptimeSec: Math.floor(process.uptime()),
                pid: process.pid,
                timestamp: new Date().toISOString(),
                details: {
                    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                    nodeEnv: process.env.NODE_ENV ?? 'unknown',
                    rooms: this.roomTable.roomTable.size,
                    database,
                },
            });
        });

        this.expressApp.use(express.json());
        this.expressApp.use(express.urlencoded({ extended: true }));

        // 라우트를 Router 하나에 모아 두 곳에 붙인다 — 루트('/')와 Nginx 접두사(BASE_PATH).
        // Nginx 의 proxy_pass 에 URI 가 없어 원본 경로(/rtc-relay/...)가 그대로 오기 때문이다.
        // 단말은 포트로 직접(루트 경로), 사람은 Nginx 를 거쳐(접두사) 같은 앱에 닿는다.
        const router = express.Router();

        // 서비스 소개. 이전에는 여기서 무인증 관리 페이지(room_status.html)를 내보냈다.
        router.get('/', (req: Request, res: Response) => {
            res.json({
                service: 'rtc-relay-server',
                status: 'ok',
                rooms: this.roomTable.roomTable.size,
                dashboard: `${BASE_PATH}${DASHBOARD_PATH}`,
            });
        });

        // WS 에코 시험 도구. 개발용이라 로그인 상태에서만 연다.
        // (이전에는 /tests 로 무인증 공개돼 있었다)
        router.get('/tests', requirePage, (req: Request, res: Response) => {
            res.sendFile(path.join(__dirname, 'public', 'echo_client.html'));
        });

        router.use('/register', Route2Register);
        router.use('/unregister', Route2Unregister);
        router.use('/user', Route2User);
        router.use('/room', Route2Room);
        router.use('/status', Route2Status); // Room table status API (Android 클라이언트가 쓴다)
        
        /**
         * @brief Mobile CRUD operations middleware - Internal access only
         * @details Restricts mobile device management operations to internal networks only.
         * Validates client IP addresses against allowed ranges:
         * - Localhost (127.0.0.1, ::1)
         * - Private networks (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
         */
        // Mobile CRUD operations - Internal access only
        // 이 경로만 router 가 아니라 앱에 직접 붙인다.
        //
        // router 는 BASE_PATH('/rtc-relay')에도 마운트되는데, Nginx 를 거쳐 들어온 요청은
        // 소켓 주소가 항상 127.0.0.1(Nginx)이라 아래 내부망 검사를 무조건 통과해 버린다.
        // 즉 프록시 경로로 노출하는 순간 IP 제한이 무의미해진다. 그래서 포트로 직접
        // 들어온 요청(루트 경로)에만 존재하게 한다.
        // 사람이 쓰는 관리 화면은 세션을 요구하는 /dashboard 쪽에 있다.
        this.expressApp.use('/mobile-crud-operation', (req: Request, res: Response, next) => {
            // 소켓의 실제 원격 주소만 본다.
            //
            // 이전에는 X-Forwarded-For 가 있으면 그 값을 그대로 신뢰했다. 이 서비스는
            // 0.0.0.0:28099 로 직접 노출돼 있어, 외부에서 'X-Forwarded-For: 127.0.0.1' 을
            // 붙이면 내부망 제한을 그냥 통과했다. 헤더는 보낸 쪽이 정하는 값이라
            // 신뢰할 수 있는 프록시를 거친 경우에만 의미가 있는데, 여기는 그렇지 않다.
            const actualIP = req.socket.remoteAddress;
            
            // Allow localhost, 127.0.0.1, and internal network ranges
            const allowedIPs = [
                '::1',           // IPv6 localhost
                '127.0.0.1',     // IPv4 localhost  
                '::ffff:127.0.0.1', // IPv4-mapped IPv6 localhost
                'localhost'
            ];
            
            /**
             * @brief Checks if IP address belongs to internal network ranges
             * @param ip The IP address to validate
             * @return boolean True if IP is in internal network range, false otherwise
             * @details Validates against RFC 1918 private network ranges:
             * - 10.0.0.0/8 (10.x.x.x)
             * - 192.168.0.0/16 (192.168.x.x)  
             * - 172.16.0.0/12 (172.16-31.x.x)
             */
            // Check for internal network ranges (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
            const isInternalNetwork = (ip: string) => {
                if (!ip) return false;
                // Remove IPv4-mapped IPv6 prefix if present
                const cleanIP = ip.replace('::ffff:', '');
                
                return /^10\./.test(cleanIP) ||           // 10.0.0.0/8
                       /^192\.168\./.test(cleanIP) ||     // 192.168.0.0/16
                       /^172\.(1[6-9]|2\d|3[01])\./.test(cleanIP); // 172.16.0.0/12
            };
            
            if (actualIP && (allowedIPs.includes(actualIP) || isInternalNetwork(actualIP))) {
                logger.info(`Mobile CRUD access granted for IP: ${actualIP || 'localhost'}`);
                next();
            } else {
                logger.warn(`Mobile CRUD access denied for IP: ${actualIP}`);
                res.status(403).json({ 
                    error: 'Access Denied', 
                    message: 'Mobile CRUD operations are only available for internal access' 
                });
            }
        }, Route2Mobile);

        // --- 관리 대시보드 ---
        //
        // manager 로그인 세션 하나로 들어온다. 이 서비스는 계정을 따로 두지 않고 검증만 한다.
        // 이전에는 같은 정보를 무인증 HTML 페이지(room_status.html, mobile_management.html)로
        // 0.0.0.0:28099 에 그대로 내보내고 있었다.
        const indexHtml = path.join(DASHBOARD_DIR, 'index.html');
        const hasBuild = fs.existsSync(indexHtml);

        router.use(`${DASHBOARD_PATH}/api`, createDashboardApi(this));

        if (hasBuild) {
            // 정적 에셋은 인증 없이 준다. (데이터가 없는 JS/CSS)
            router.use(`${DASHBOARD_PATH}/assets`, express.static(path.join(DASHBOARD_DIR, 'assets'), {
                immutable: true,
                maxAge: '1y',
            }));

            // 페이지는 로그인 상태에서만 열리며, 아니면 manager 로그인으로 보낸다.
            router.get(`${DASHBOARD_PATH}`, requirePage, (req: Request, res: Response) => res.sendFile(indexHtml));
            router.get(`${DASHBOARD_PATH}/*`, requirePage, (req: Request, res: Response) => res.sendFile(indexHtml));
        } else {
            logger.warn(`대시보드 빌드를 찾을 수 없습니다: ${DASHBOARD_DIR} — "cd web && npm install && npm run build"`);
            router.get(`${DASHBOARD_PATH}*`, (req: Request, res: Response) => {
                res.status(503).type('text/plain')
                   .send('Dashboard build not found. Run: cd services/rtc-relay-server/web && npm install && npm run build');
            });
        }

        // 루트와 Nginx 접두사 양쪽에 같은 라우터를 붙인다.
        this.expressApp.use('/', router);
        this.expressApp.use(BASE_PATH, router);
        this.hasDashboardBuild = hasBuild;

        // General https server with the short-term certificate
        this.httpsServer = https.createServer(httpsOptions, this.expressApp); // Changed to HTTPS server


        // 스키마는 이 서비스가 소유한다 — schema/001-initial.sql.
        // database/database.ini 의 [database:rtc_relay] 가 그 디렉토리를 가리키고,
        // sudo database/setup_mariadb.sh 가 적용한다. 런타임에 테이블을 만들지 않는다.
        logger.info(`rtc-relay-server created`);
    }

    /**
     * @brief Creates a secret room with a persistent room number
     * @details Uses a saved room number from file, or generates a new one if none exists.
     * This room is created automatically on server startup for private administrative access.
     * The room number persists across server restarts and is kept secret.
     * 
     * @return number The secret room number (kept private)
     */
    private createSecretRoom(): number {
        const secretRoomFile = path.join(__dirname, '.secret-room-id');
        
        try {
            // Try to load existing secret room number from file
            if (fs.existsSync(secretRoomFile)) {
                const savedNumber = fs.readFileSync(secretRoomFile, 'utf8').trim();
                this.secretRoomNumber = parseInt(savedNumber, 10);
                
                if (!isNaN(this.secretRoomNumber) && this.secretRoomNumber > 0) {
                    logger.info('Loading existing secret administrative room number');
                } else {
                    throw new Error('Invalid saved room number');
                }
            } else {
                // Generate a new cryptographically secure random number
                const min = 100000000; // 9-digit minimum
                const max = 999999999; // 9-digit maximum
                const range = max - min + 1;
                
                // Use crypto.randomBytes for cryptographically secure random generation
                const randomBytes = crypto.randomBytes(4);
                const randomValue = randomBytes.readUInt32BE(0);
                this.secretRoomNumber = min + (randomValue % range);
                
                // Save the secret room number to file for persistence
                fs.writeFileSync(secretRoomFile, this.secretRoomNumber.toString(), 'utf8');
                
                // Set restrictive file permissions (owner read/write only)
                fs.chmodSync(secretRoomFile, 0o600);
                
                logger.info('Generated new secret administrative room number and saved for future use');
            }
        } catch (error) {
            logger.error('Error handling secret room file, generating new number:', error);
            
            // Fallback: generate new number without saving
            const min = 100000000;
            const max = 999999999;
            const range = max - min + 1;
            const randomBytes = crypto.randomBytes(4);
            const randomValue = randomBytes.readUInt32BE(0);
            this.secretRoomNumber = min + (randomValue % range);
        }
        
        // Create the secret room
        const secretRoom = this.roomTable.createRoom(this.secretRoomNumber);
        if (secretRoom) {
            logger.info('Secret administrative room has been created and is ready for private access');
            logger.debug('Secret room initialized successfully'); // Debug level to avoid exposing in production
        } else {
            logger.error('Failed to create secret administrative room');
        }
        
        return this.secretRoomNumber;
    }

    /**
     * @brief Starts the main CallFusion WebRTC server service
     * @details Initiates the HTTPS server on the configured port and starts
     * the WebSocket service for real-time communication. The server handles:
     * - REST API endpoints for device registration and room management
     * - WebSocket connections for RTC and IoT messaging
     * - SSL/TLS encrypted connections
     * 
     * @note Default port is 28090 if HTTPS_PORT environment variable is not set
     */
    public startService() : void {
        const HTTPS_PORT = process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT) : 28090;
        logger.info(`rtc-relay-server is listening on https://0.0.0.0:${HTTPS_PORT}`);
        this.httpsServer.listen(HTTPS_PORT, () => {
            //let endpoints = new WebSocketRouter().express.get('websocket endpoints');
            //console.log(`endpoints to the websocke routes are: ${endpoints}`);
            logger.info(`Dashboard: ${BASE_PATH}${DASHBOARD_PATH}${this.hasDashboardBuild ? '' : ' (빌드 없음)'}`);
            if(this.httpsServer && this.httpsServer.address()) {
                console.log("websocket service is starting..." + JSON.stringify(this.httpsServer.address()));
                
                // Create the secret room for administrative access
                this.createSecretRoom();
                
                startWebsocketService(this);
            }
        });
    }

    /**
     * @brief Stops all server services gracefully
     * @details Closes the HTTPS server and resolves once all connections are
     * released. pm2 가 재시작할 때 SIGTERM 을 보내므로 아래에서 이 메서드를
     * 신호 처리기에 연결한다. (watch = src 라 소스 수정 시마다 재시작한다)
     */
    public async stopService(): Promise<void> {
        await new Promise<void>((resolve) => this.httpsServer.close(() => resolve()));
        await DbConn.close().catch(() => {});
    }
}

/**
 * @brief Server initialization and startup
 * @details Creates the singleton CallFusion instance and starts the main service.
 * The certificate download service is commented out by default.
 */
const callFusion = CallFusion.getInstance();
callFusion.startService();

// pm2 restart/stop 은 SIGTERM 을, Ctrl-C 는 SIGINT 를 보낸다.
// 처리기가 없으면 연결이 정리되지 않은 채 프로세스가 끊긴다.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        logger.info(`${signal} received, shutting down...`);
        callFusion.stopService().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    });
}

export default callFusion;
