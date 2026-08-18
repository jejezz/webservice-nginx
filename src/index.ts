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

console.log(`type script src/index.ts to start the callfusion2rtc server.`);
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
import sqlite3 from 'sqlite3';
import logger from './libs/logger.js'; // Import your configured logger

// ES module compatible __filename and __dirname
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.title = "callfusion2rtc";

/**
 * @brief Validates essential environment variables and provides warnings for missing optional ones
 * @details Checks for required configuration and logs helpful messages for optional settings
 */
function validateEnvironmentVariables(): void {
    const requiredVars = ['HTTPS_PORT'];
    const optionalVars = [
        'SSL_PRIVATE_KEY_PATH', 'SSL_CERTIFICATE_PATH', 'SSL_CA_PATH',
        'SQLITE_DB_PATH', 'MOBILE_TABLE_NAME', 'FIREBASE_SERVICE_ACCOUNT_PATH'
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
    logger.info(`- Database Path: ${process.env.SQLITE_DB_PATH || './cf2rtc-sqlite-db.db (default)'}`);
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
    
    /** @brief Express application for certificate download service */
    public downloadExpressApp: express.Application;
    
    /** @brief HTTPS server for certificate download (optional service) */
    public downloadServer: https.Server | undefined;
    
    /** @brief Room table managing all WebRTC rooms and client connections */
    public roomTable: RtcRoomTable; // timeout in milliseconds
    
    /** @brief Secret room number for private server access - not exposed publicly */
    private secretRoomNumber: number;
    
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
        this.downloadExpressApp = express();
        
          /**
         * @brief SSL/TLS certificate configuration with environment variable support
         * @details Loads certificate paths from environment variables with fallbacks
         */
        const privateKey = process.env.SSL_PRIVATE_KEY_PATH || path.join(__dirname, 'certs', 'server.key');
        const certificate = process.env.SSL_CERTIFICATE_PATH || path.join(__dirname, 'certs', 'renewed_server.crt');
        const ca = process.env.SSL_CA_PATH || path.join(__dirname, 'certs', 'intermediate-ca.crt');

        // Check if certificate files exist
        if (!fs.existsSync(privateKey) || !fs.existsSync(certificate) || !fs.existsSync(ca)) {
            logger.error('SSL/TLS certificate files not found.');
            logger.error(`Certificate paths: key=${privateKey}, cert=${certificate}, ca=${ca}`);
            logger.error(`Please ensure certificate files exist or update environment variables.`);
            logger.error('Check Certificate.md for detailed information');
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
        this.expressApp.get('/health', (req: Request, res: Response) => {
            res.status(200).json({
                service: 'callfusion2rtc',
                status: 'ok',
                uptimeSec: Math.floor(process.uptime()),
                pid: process.pid,
                timestamp: new Date().toISOString(),
                details: {
                    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                    nodeEnv: process.env.NODE_ENV ?? 'unknown',
                },
            });
        });

        // basic response
        this.expressApp.get('/tests', (req: Request, res: Response) => {
            const HTML_FILE_PATH = path.join(__dirname, 'public', 'echo_client.html');
            // Serve the index.html file
            fs.readFile(HTML_FILE_PATH, (err, data) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error: Could not load echo_client.html');
                    logger.error(`Error reading ${HTML_FILE_PATH}:`, err);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        });
        
        // Room status page
        this.expressApp.get('/', (req: Request, res: Response) => {
            const HTML_FILE_PATH = path.join(__dirname, 'public', 'room_status.html');
            fs.readFile(HTML_FILE_PATH, (err, data) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error: Could not load room_status.html');
                    logger.error(`Error reading ${HTML_FILE_PATH}:`, err);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        });
        
        // Mobile management page
        this.expressApp.get('/mobiles', (req: Request, res: Response) => {
            const HTML_FILE_PATH = path.join(__dirname, 'public', 'mobile_management.html');
            fs.readFile(HTML_FILE_PATH, (err, data) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error: Could not load mobile_management.html');
                    logger.error(`Error reading ${HTML_FILE_PATH}:`, err);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        });
        
        this.expressApp.use(express.json());
        this.expressApp.use(express.urlencoded({ extended: true }));
        this.expressApp.use('/register', Route2Register);
        this.expressApp.use('/unregister', Route2Unregister);
        this.expressApp.use('/user', Route2User);
        this.expressApp.use('/room', Route2Room);
        this.expressApp.use('/status', Route2Status); // Room table status API
        
        /**
         * @brief Mobile CRUD operations middleware - Internal access only
         * @details Restricts mobile device management operations to internal networks only.
         * Validates client IP addresses against allowed ranges:
         * - Localhost (127.0.0.1, ::1)
         * - Private networks (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
         */
        // Mobile CRUD operations - Internal access only
        this.expressApp.use('/mobile-crud-operation', (req: Request, res: Response, next) => {
            const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
            const forwardedIPs = req.headers['x-forwarded-for'] as string;
            
            // Get the actual client IP (handle proxy forwarding)
            const actualIP = forwardedIPs ? forwardedIPs.split(',')[0].trim() : clientIP;
            
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
            
            if ((actualIP && allowedIPs.includes(actualIP)) || (actualIP && isInternalNetwork(actualIP)) || actualIP === undefined) {
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
        // General https server with the short-term certificate
        this.httpsServer = https.createServer(httpsOptions, this.expressApp); // Changed to HTTPS server


        /**
         * @brief SQLite database initialization
         * @details Creates or connects to the SQLite database file and initializes
         * the mobile device registration table with the following schema:
         * - id: Primary key (auto-increment)
         * - uuid: Device unique identifier
         * - email: User email address
         * - complex: Building/complex information
         * - address: Device address
         * - token: Push notification token
         * - active: Device activation status (default: 1)
         * - created: Registration timestamp
         */
        const db = sqlite3.verbose().Database;
        // SQLite database file creation or connection with environment variable support
        const dbPath = process.env.SQLITE_DB_PATH || './cf2rtc-sqlite-db.db';
        let sqliteDb = new db(dbPath, (err: any) => {
            if (err) {
                logger.error('Failed to connect to the database:', err.message);
                return;
            }
            logger.info('Connected to the SQLite database.');
        });

        // Create mobile device registration table
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS ${CallFusion.tableForMobile} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT NOT NULL,
            email TEXT NOT NULL,
            complex TEXT NOT NULL,
            address TEXT NOT NULL,
            token TEXT NOT NULL,
            phone TEXT,
            image BLOB,
            active INTEGER DEFAULT 1,
            created TEXT NOT NULL
        )`, (err: any) => {
            if (err) {
                logger.error('Failed to create table:', err.message);
                return;
            }
            logger.info('SQLite DB Table created successfully.');
        });        
        logger.info(`callfusion RTC server created`);
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
     * @brief Gets the secret room number (for internal use only)
     * @return number The secret room number
     * @note This method should only be used internally and never expose the number publicly
     */
    public getSecretRoomNumber(): number {
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
        logger.info(`callfusion RTC server is listening on https://xxxxxxxxxx:${HTTPS_PORT}`);
        this.httpsServer.listen(HTTPS_PORT, () => {
            //let endpoints = new WebSocketRouter().express.get('websocket endpoints');
            //console.log(`endpoints to the websocke routes are: ${endpoints}`);
            if(this.httpsServer && this.httpsServer.address()) {
                console.log("websocket service is starting..." + JSON.stringify(this.httpsServer.address()));
                
                // Create the secret room for administrative access
                this.createSecretRoom();
                
                startWebsocketService(this);
            }
        });
    }

    /**
     * @brief Starts the certificate download service (optional)
     * @details Provides a separate HTTPS server for downloading SSL certificates.
     * Uses long-term certificates and serves files from the 'certs' directory
     * under the '/download' path. Runs on main port + 1.
     * 
     * @note This service is optional and typically used for certificate distribution
     * @throws Error if long-term certificate files are missing
     */
    public startDownloadService() : void {
        
        // Serve files from the 'certs' directory under the '/download' path
        this.downloadExpressApp.use('/download', express.static(path.join(__dirname, 'certs')));
              // Paths for SSL/TLS certificates with environment variable support
        const privateKeyPath1 = process.env.SSL_LONGLIVE_PRIVATE_KEY_PATH || path.join(__dirname, 'certs-longlive', 'key.pem');
        const certificatePath1 = process.env.SSL_LONGLIVE_CERTIFICATE_PATH || path.join(__dirname, 'certs-longlive', 'cert.pem');

        // Check if certificate files exist
        if (!fs.existsSync(privateKeyPath1) || !fs.existsSync(certificatePath1)) {
            logger.error('SSL/TLS certificate files not found.');
            logger.error(`Please ensure 'key.pem' and 'cert.pem' are in the '${path.join(__dirname, 'certs')}' directory.`);
            logger.error('You can generate self-signed certificates for testing using:');
            logger.error('openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365');
            process.exit(1); // Exit if certs are missing
        }

        const httpsOptions1 = {
            key: fs.readFileSync(privateKeyPath1),
            cert: fs.readFileSync(certificatePath1),
        };
        // certificate download server with long-term certificate
        this.downloadServer = https.createServer(httpsOptions1, this.downloadExpressApp); // Changed to HTTPS server

        const HTTPS_PORT = (process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT) : 28090) + 1;
        //logger.info(`callfusion RTC server is listening on https://callfusion.ptype.co.kr:${HTTPS_PORT}`);
        this.downloadServer.listen(HTTPS_PORT, () => {
            logger.info(`Certificate download server is listening on ${HTTPS_PORT}`);
        });

    }

    /**
     * @brief Stops all server services gracefully
     * @details Closes both the main HTTPS server and the certificate download
     * server (if running). This method should be called during application
     * shutdown to properly release resources and close connections.
     */
    public stopService() : void {
        this.httpsServer.close();
        if(this.downloadServer)
            this.downloadServer.close();
    }
}

/**
 * @brief Server initialization and startup
 * @details Creates the singleton CallFusion instance and starts the main service.
 * The certificate download service is commented out by default.
 */
const callFusion = CallFusion.getInstance();
callFusion.startService();
//callFusion.startDownloadService();

export default callFusion;
