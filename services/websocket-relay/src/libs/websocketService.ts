/**
 * @file ws_rtc.ts
 * @brief WebSocket service for RTC and IoT message handling in CallFusion system
 * @author CallFusion Team
 * @date 2024
 * @version 1.0.0
 * 
 * @description
 * This module provides the core WebSocket service for the CallFusion WebRTC system.
 * It handles both RTC (Real-Time Communication) and IoT device messaging through
 * WebSocket connections. Key features include:
 * 
 * - Dual protocol support: RTC (/relay/rtc) and IoT (/relay/iot) WebSocket endpoints
 * - Client connection lifecycle management with ping/pong heartbeat
 * - Room-based message routing and client management
 * - Firebase Cloud Messaging integration for push notifications
 * - IoT device registration, control, and status monitoring
 * - Real-time message broadcasting and peer-to-peer communication
 * - Targeted notification system with email filtering
 * - Connection health monitoring and automatic cleanup
 * 
 * The service follows a singleton pattern and integrates with the CallFusion
 * main application instance to provide comprehensive WebSocket functionality.
 */

import express, { Request, Response, NextFunction } from 'express';
import { WebSocket, WebSocketServer, RawData as WebSocketRawData } from 'ws';
import { RtcClient } from './rtcClient';
import { RtcRoom, InviteCallback, RTC_ROOM_TAKEN } from './rtcRoom';
import { Utils } from './utils';
import config from '../config';
import type { RelayGateway } from '../gateway';
import { TokenMessage } from 'firebase-admin/messaging';
import { DbConn } from './dbConnection';
import { sendToTargets, PushTarget } from './push';
import { complexClause, pointsToAnotherComplex, COMPLEX_ID } from './complex';
import { IoTMessage, ClientMessage } from './clientMessage';
import logger from './logger'; // Import your configured logger

/**
 * @brief WebSocket URL path constants for routing WebSocket connections
 * @details Defines the supported WebSocket endpoint paths for different protocols
 */
// WebSocket URL path constants for better code clarity and maintainability
/**
 * @brief WebSocket 경로.
 *
 * nginx 가 접두사를 잘라내지 않고 원본 URI 를 그대로 넘기므로 (그 이유는
 * config 의 basePath 주석에 있다), 공개 주소 `/relay/rtc` 는 여기에도
 * `/relay/rtc` 로 도착한다. 그래서 라우터를 두 곳에 붙이는 것과 같은 방식으로
 * 접두사가 붙은 경로도 함께 받는다.
 *
 *   공개                        이 서버가 보는 경로
 *   wss://호스트/relay/rtc      /relay/rtc   ← nginx 경유 (단말이 쓰는 길)
 *   wss://호스트/relay/iot      /relay/iot   ← nginx 경유
 *   ws://127.0.0.1:28099/rtc    /rtc         ← 같은 호스트에서 직접 (시험용)
 */
/**
 * @brief 홈넷 상태를 구독 단말들에 뿌릴 때 **보낸 것들 사이의** 간격(ms).
 *
 * 예전에는 500ms 가 못박혀 있었고, 그 대기가 대상이 아닌 클라이언트에도 걸려
 * 있어서 구독 3대에 1.5초가 걸렸다(실측). 원래 의도는 IoT 장치를 몰아치지
 * 않으려는 것이었는데, 이 경로의 수신자는 이미 연결된 소켓 너머의 **모바일**
 * 이라 늦출 이유가 없다. 기본값을 0 으로 두고, 특정 단말이 감당하지 못하는
 * 일이 생기면 이 값으로 되돌릴 수 있게 남겨 둔다.
 */
const IOT_STATUS_DELAY_MS = config.ws.iotStatusDelayMs;

const BASE = config.basePath.replace(/\/+$/, '');
const RTC_PATHS = new Set([`${BASE}/rtc`, '/rtc']);
const IOT_PATHS = new Set([`${BASE}/iot`, '/iot']);

/**
 * 질의 문자열과 끝 슬래시를 떼어 낸다.
 * 예전에는 `/ws` 와 `/ws/` 두 상수를 따로 두고 정확히 비교했는데, 경로가
 * 늘어날수록 조합이 배로 늘어난다. 정규화를 한 번 하는 편이 낫다.
 */
function wsPathOf(rawUrl: string): string {
    return rawUrl.split('?')[0].replace(/\/+$/, '') || '/';
}

/**
 * @brief WebSocket method constants for message type identification
 * @details Defines all supported WebSocket message methods for both RTC and IoT protocols
 */
// WebSocket method constants for better code clarity and maintainability
const WS_METHODS = {
    // RTC Methods
    /** @brief Client invitation to join a room */
    INVITE: 'invite',
    /** @brief Acknowledgment of invitation */
    INVITE_ACK: 'invite-ack',
    /** @brief WebRTC offer message */
    OFFER: 'offer',
    /** @brief WebRTC answer message */
    ANSWER: 'answer',
    /** @brief Call acceptance message */
    ACCEPT: 'accept',
    /** @brief ICE candidate exchange */
    CANDIDATE: 'candidate',
    /** @brief Remove ICE candidates */
    REMOVE_CANDIDATES: 'remove-candidates',
    /** @brief End call/session message */
    BYE: 'bye',
    /** @brief Error notification message */
    ERROR: 'error',
    
    // IoT Methods
    /** @brief Create IoT room/device */
    CREATE: 'create',
    /** @brief Modify IoT device configuration */
    MODIFY: 'modify',
    /** @brief Join existing IoT room */
    JOIN: 'join',
    /** @brief Subscribe to IoT device updates */
    SUBSCRIBE: 'subscribe',
    /** @brief IoT device control command */
    IOT_CONTROL: 'iot-control',
    /** @brief IoT device status request */
    IOT_STATUS: 'iot-status',
    /** @brief Unsubscribe from IoT updates */
    UNSUBSCRIBE: 'unsubscribe'
} as const;

/**
 * @class WebSocketService
 * @brief Main WebSocket service class implementing singleton pattern
 * 
 * @details
 * The WebSocketService class manages all WebSocket connections and message routing
 * for the CallFusion system. It provides:
 * - Singleton pattern for centralized WebSocket management
 * - Dual protocol support: RTC and IoT WebSocket endpoints
 * - Client lifecycle management with heartbeat monitoring
 * - Room-based message routing and broadcasting
 * - Firebase push notification integration
 * - IoT device registration and control
 * - Connection health monitoring and cleanup
 * 
 * The service integrates with the CallFusion application instance and manages
 * both real-time communication and IoT device messaging through WebSocket
 * connections on different endpoints.
 */
export class WebSocketService {

    /** @brief Singleton instance of WebSocketService */
    private static instance : WebSocketService | null = null;
    
    /**
     * @brief Gets the singleton instance of WebSocketService
     * @return WebSocketService|null The singleton instance or null if not created
     */
    public static getInstance() : WebSocketService | null {
        return WebSocketService.instance;
    }

    /**
     * @brief Creates or returns the singleton instance of WebSocketService
     * @param callFusion 실행 중인 릴레이 게이트웨이
     * @return WebSocketService The singleton instance
     * 
     * @details
     * Creates a new WebSocketService instance if none exists, otherwise
     * returns the existing singleton instance. This ensures only one
     * WebSocket service runs in the application.
     */
    public static createInstance(callFusion: RelayGateway): WebSocketService {
        if (!WebSocketService.instance) {
            WebSocketService.instance = new WebSocketService(callFusion);
        }
        return WebSocketService.instance;
    }

    /** @brief Reference to the main CallFusion application instance */
    private app: RelayGateway;
    
    /** @brief WebSocket server instance for handling connections */
    private rtcServer: WebSocketServer;
    
    /** @brief Express application instance from CallFusion */
    private express : express.Application;

    /**
     * @brief Private constructor implementing singleton pattern
     * @param callFusion 실행 중인 릴레이 게이트웨이
     * 
     * @details
     * Initializes the WebSocket service with:
     * - WebSocket server configuration and connection handling
     * - URL-based routing for RTC (/relay/rtc) and IoT (/relay/iot) protocols
     * - Ping/pong heartbeat mechanism for connection health monitoring
     * - Automatic cleanup of disconnected clients every 60 seconds
     * - Error handling and connection management
     */
    private constructor(callFusion : RelayGateway) {
        this.app = callFusion;
        this.express = callFusion.expressApp;
        
        // clientTracking: false — ws 가 내부에 유지하는 클라이언트 Set 을 쓰지 않는다.
        // 방(room) 쪽에서 이미 관리하고 있어 중복이고, 연결 수만큼 커진다.
        this.rtcServer = new WebSocketServer({ server: callFusion.httpServer, clientTracking: false });
        /**
         * @brief WebSocket connection handler with protocol routing
         * @details Handles new WebSocket connections and routes them based on URL path:
         * - /relay/rtc → RTC message handling for voice/video calls
         * - /relay/iot → IoT message handling for device communication
         * - Invalid paths → Connection rejection
         * 
         * Also sets up pong handler for heartbeat mechanism to track client health.
         */
        this.rtcServer.on('connection', (ws: WebSocket, req: Request) => {
            //const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            ws.on('pong', () => {
                this.app.roomTable.findClient(ws)?.setAlive(true); // 30 seconds
            });

            const path = wsPathOf(req.url || '');
            if (RTC_PATHS.has(path)) {
                logger.info(`[RTC] new websocket client detected - ${req.url}`);
                this.handleRtcMessage(ws, req);
            } else if (IOT_PATHS.has(path)) {
                logger.info(`[IOT] new websocket client detected - ${req.url}`);
                this.handleIoTMessage(ws, req);
            } else {
                logger.error(`Rejected connection: invalid path, ${req.url}`);
                ws.close(1008, 'unknown path');
            }
        });

        /**
         * @brief Heartbeat mechanism for client health monitoring
         * @details Runs every 60 seconds to:
         * - Check if clients responded to previous ping (isAlive)
         * - Close connections for unresponsive clients
         * - Send new ping to remaining clients
         * - Log total active client count for monitoring
         * 
         * This prevents accumulation of dead connections and ensures
         * accurate client count and room state management.
         */
        setInterval(() => {
            let clients : number = 0;
            // Ping all clients in all rooms to check if they are alive
            for (let room of this.app.roomTable.roomTable.values()) {
                room.clients.forEach((client: RtcClient) => {
                    clients++;
                    if (client.isAlive() === false) {
                        logger.warn("Client is not alive, closing connection: ", client.cid);
                        client.leave();
                        return;
                    }
                    client.setAlive(false);
                    // 아직 소켓이 붙지 않은(또는 이미 닫힌) 클라이언트에 ping 하면
                    // 던진다. 여기는 타이머 콜백이라 예외가 safeHandle 밖이고,
                    // 그대로 두면 heartbeat 한 번이 서버 전체를 위협한다.
                    // ping 을 건너뛰어도 위에서 alive 를 내려 놨으므로
                    // 다음 주기에 정리된다.
                    if (!client.isOpened()) {
                        return;
                    }
                    try {
                        client.websocket.ping();
                    } catch (err: any) {
                        logger.warn(`ping 실패 (client ${client.cid}): ${err?.message ?? err}`);
                    }
                });
            }
            logger.info(`Checking for alive clients... (${clients})`);
        }, config.ws.pingIntervalMs); // 기본 60초마다 ping
        logger.info("web socket server created.");
    }


    /**
     * @brief Generates a random numeric string of specified length
     * @param length Number of digits in the generated string
     * @return string Random numeric string
     * 
     * @details
     * Creates random identifiers used for client IDs and room IDs.
     * Each character is a random digit (0-9), providing sufficient
     * uniqueness for session identification within the system.
     */
    private generateRandomNumber(length: number): string {
        let word = '';
        for (var i = 0; i < length; i++) {
            word += Math.floor((Math.random() * 10));
        }
        return word;
    }

    /**
     * @brief Extracts building address from RTC receiver string format
     * @param receiver RTC receiver string in format "rtc:address@domain"
     * @return string Extracted building address or empty string if malformed
     * 
     * @details
     * Parses RTC protocol receiver strings to extract building addresses:
     * - Expects format: "rtc:address@domain" where address is the building identifier
     * - Strips "rtc:" prefix and extracts address portion before "@" symbol
     * - Logs successful address extraction for debugging and monitoring
     * - Handles malformed receiver strings with error logging
     * - Essential for Firebase notification targeting by building address
     * - Used in visitor notification system for intercom integration
     * - Returns empty string as safe fallback for invalid input formats
     */
    private getAddressFrom(receiver : string): string {
        let results = receiver.trim();
        if (receiver.startsWith('rtc:')) {
            let ends = receiver.indexOf('@');
            results = receiver.substring(4, ends);
            logger.info(receiver + ' -> ' + results);
        }
        else {
            logger.error("mal-formatted agent string");
        }
        return results || '';
    }
    
    /**
     * @brief 파싱하지 못한 입력에 대한 응답.
     * @details 보낸 쪽 형식이 틀렸다는 뜻이며, 정상 응답과 섞이면 안 된다.
     * 이전에는 sendOk 하나가 이 문구를 붙여 IoT 성공 응답에도 따라붙었다. */
    private sendNotUnderstood(ws: WebSocket, raw: string) : void {
        if(ws != null) {
            logger.warn(`파싱할 수 없는 입력: ${raw.slice(0, 200)}`);
            this.safeSend(ws, "I don't know what to do with:" + raw);
        }
    } 

    /**
     * @brief Sends error message and closes WebSocket connection
     * @param ws WebSocket connection to send error to
     * @param e Error object containing error details
     * 
     * @details
     * Error handling method for critical WebSocket failures:
     * - Logs error message for debugging
     * - Sends error message to client with "ERROR:" prefix
     * - Closes WebSocket connection to prevent further issues
     * - Used for unrecoverable connection or protocol errors
     */
    private sendError(ws: WebSocket, e :  Error): void {
        if(ws != null) {
            logger.warn(`connection error, closing: ${e.message}`);
            this.safeSend(ws, "ERROR:" + e.message);
            ws.close();
        }
    }

    /**
     * @brief 소켓이 열려 있을 때만 보낸다.
     * @param ws 보낼 대상
     * @param payload 보낼 문자열
     *
     * @details
     * 닫혔거나 닫히는 중인 소켓에 ws.send 를 하면 오류가 나는데, 그게 메시지
     * 핸들러 밖으로 새어 나가면 프로세스 전체가 위험해진다. 상대가 이미
     * 끊은 것은 정상적인 상황이므로 조용히 버린다.
     */
    private safeSend(ws: WebSocket, payload: string): void {
        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            ws.send(payload);
        } catch (err: any) {
            logger.warn(`failed to send: ${err?.message ?? err}`);
        }
    }

    /**
     * @brief 메시지 핸들러의 예외 경계.
     * @param ws 이 메시지를 보낸 연결
     * @param label 로그에 남길 이름
     * @param handler 실제 처리
     *
     * @details
     * ws 의 'message' 리스너는 동기라, 안에서 던진 예외는 EventEmitter 를 지나
     * uncaughtException 까지 올라간다. 이전에는 그 처리기가 process.exit(1)
     * 이었으므로 **클라이언트 한 대의 잘못된 요청이 접속자 전원을 끊었다.**
     * (정원 찬 방에 invite, 큐 1024개 초과 등 실제로 throw 하는 경로가 여럿 있다.)
     *
     * 여기서 잡아 그 연결 하나만 끊는다. 나머지 통화는 영향을 받지 않는다.
     */
    private safeHandle(ws: WebSocket, label: string, handler: () => void): void {
        try {
            handler();
        } catch (err: any) {
            logger.error(`[${label}] 처리 중 오류, 이 연결만 끊습니다: ${err?.message ?? err}`, err);
            this.safeSend(ws, "ERROR:" + (err?.message ?? 'internal error'));
            ws.close();
        }
    }

    /**
     * @brief Validates required fields in client WebSocket messages
     * @param ws WebSocket connection for error reporting
     * @param msg ClientMessage object to validate
     * @return boolean true if all required fields present, false otherwise
     * 
     * @details
     * Message validation ensures protocol compliance:
     * - Checks for required fields: roomid, sender, device, receiver
     * - Sends specific error messages for missing fields
     * - Prevents processing of malformed or incomplete messages
     * - Essential for WebRTC signaling protocol integrity
     */
    private validateClientMessage(ws: WebSocket, msg: ClientMessage): boolean {
        const requiredFields = [
            { field: 'roomid', name: 'roomid' },
            { field: 'sender', name: 'sender' },
            { field: 'device', name: 'device' },
            { field: 'receiver', name: 'receiver' }
        ];

        for (const { field, name } of requiredFields) {
            if (!msg[field as keyof ClientMessage]) {
                this.sendError(ws, Error(`invalid register request: missing '${name}'`));
                return false;
            }
        }
        return true;
    }
       
    /**
     * @brief Extracts IPv4 address from IPv6-mapped IPv4 address
     * @param ipAddress IP address string to process
     * @return string Pure IPv4 address or original input if not mapped
     * 
     * @details
     * Handles dual-stack networking IP address normalization:
     * - Detects IPv6-mapped IPv4 addresses (format: ::ffff:x.x.x.x)
     * - Extracts the embedded IPv4 portion for consistent processing
     * - Returns original address if not in mapped format
     * - Essential for IoT device identification across network types
     * - Supports both native IPv4 and IPv6 environments
     */
    private extractIPv4FromMappedIPv6(ipAddress: string): string {
        // Check if the address starts with the IPv4-mapped prefix
        if (ipAddress && typeof ipAddress === 'string' && ipAddress.startsWith('::ffff:')) {
            // Extract the part after '::ffff:'
            const ipv4Part = ipAddress.substring(7); // '::ffff:'.length is 7
            return ipv4Part;
        }
        // If it's not a string, or doesn't match the mapped format, return it as is.
        // This covers native IPv4 addresses, regular IPv6 addresses, or null/undefined inputs.
        return ipAddress;
    }

    // ===== RTC MESSAGE HANDLER =====
    /**
     * @brief Handles RTC WebSocket messages for voice/video communication
     * @param ws WebSocket connection instance
     * @param req HTTP request object from WebSocket upgrade
     * 
     * @details
     * Sets up message handling for RTC protocol WebSocket connections:
     * - Parses incoming JSON messages and routes by method type
     * - Handles invite, offer, answer, candidate, and bye messages
     * - Manages client registration and room participation
     * - Provides error handling and connection cleanup
     * - Supports WebRTC signaling protocol for peer connections
     */
    private handleRtcMessage(ws: WebSocket, req: Request) {
     
        // safeHandle 로 감싼다 — 이 안에서 던진 예외가 밖으로 나가면
        // uncaughtException 까지 올라가 서버 전체가 영향을 받는다.
        ws.on('message', (data: WebSocketRawData) => this.safeHandle(ws, 'RTC', () => {
            let json;
            const raw = data.toLocaleString();
            try {
                json = JSON.parse(raw);
            }
            catch (e) {
                return this.sendNotUnderstood(ws, raw);
            }
            // 본문 전체를 info 로 남기지 않는다. 통화 하나에 SDP(수 KB)와
            // ICE candidate 수십 개가 오가므로, 여기서 payload 를 찍으면
            // 통화량이 아니라 로그 쓰기가 먼저 서버를 묶는다.
            logger.debug('[RTC] message %s (%d bytes)', json.method, raw.length);

            if (json.method === undefined) {
                return this.sendError(ws, Error("method field not found"));
            }
            switch (json.method) {
                case WS_METHODS.INVITE:
                    return this._handleRtcInviteClient(ws, json);
                case WS_METHODS.INVITE_ACK:
                    return this._handleRtcInviteClientAndAck(ws, json);
                case WS_METHODS.OFFER:
                case WS_METHODS.ANSWER:
                case WS_METHODS.ACCEPT:
                case WS_METHODS.CANDIDATE:
                case WS_METHODS.REMOVE_CANDIDATES:
                    return this._handleRtcBroadcastMessage(ws, json);
                case WS_METHODS.BYE:
                case WS_METHODS.ERROR:
                    if(this._handleRtcRemoveClient(ws, json)) {
                        return this._handleRtcBroadcastMessage(ws, json);
                    }
                    break;
                default:
                    logger.error("invalid message: unexpected 'method' " , json.method);
                    return;
            }
        }));

        ws.once('error', error => {
            logger.error("error recieved: " + error.message + ", close connection");
            ws.close();
        });
        
        ws.once('close', () => {
            this.app.roomTable.removeClientFromRooms(ws);
        });   
    }


    // ===== RTC METHODS =====
    
    /**
     * @brief Broadcasts WebRTC signaling message to room participants
     * @param ws WebSocket connection from sender
     * @param msg ClientMessage containing room and client information
     * 
     * @details
     * Core WebRTC message routing functionality:
     * - Validates message structure and sender authentication
     * - Verifies sender is joined to the target room
     * - Routes signaling messages (offer, answer, candidate) to room participants
     * - Handles WebRTC peer-to-peer connection establishment
     * - Provides error handling for invalid requests or unauthorized access
     */
    private _handleRtcBroadcastMessage(ws: WebSocket, msg : ClientMessage): void {
        if(!msg) 
            return this.sendError(ws, Error('invalid send request: missing message'));

        if (!this.validateClientMessage(ws, msg)) {
            return;
        }
        
        // 발신자는 **소켓**으로 정한다. 메시지의 clientid 는 보낸 쪽이 적는 값이라
        // 같은 방 안에서 남의 것을 적을 수 있고, 어긋나면 메시지가 조용히 사라졌다.
        // 이 호출이 소속 확인까지 겸하므로 isJoinedToRoom 을 따로 보지 않는다.
        if (!this.app.roomTable.sendFromWebsocket(parseInt(msg.roomid), ws, msg)) {
            logger.warn("client is not joined to the room");
        }
    }


    /**
     * @brief Registers RTC client to room and triggers Firebase notifications
     * @param ws WebSocket connection from inviting client
     * @param msg ClientMessage containing invitation details and room information
     * @return boolean true if invitation process initiated successfully, false on validation failure
     * 
     * @details
     * Core RTC client invitation and room registration functionality:
     * - Validates required message fields for invitation request
     * - Extracts building address from receiver field for notification targeting
     * - Generates unique 8-digit client ID for room participation
     * - Registers client with room table using callback-based invitation system
     * - Triggers Firebase push notifications if client is room initiator
     * - Sends client update message with assigned client ID for confirmation
     * - Handles registration errors with detailed logging and client notification
     * - Essential for WebRTC call initiation and visitor notification systems
     */
    private _handleRtcInviteClient(ws: WebSocket, msg: ClientMessage): boolean {
        
        if (!this.validateClientMessage(ws, msg)) {
            return false;
        }
        
        const address = this.getAddressFrom(msg.receiver);

        // receiver 의 '@' 뒤가 다른 단지를 가리키면 보내지 않는다.
        // 옛 형식(호스트 이름)이면 판단하지 않는다 — 지금 도는 인터폰을
        // 깨지 않기 위해서다 (libs/complex.ts 의 complexFromAgent).
        if (pointsToAnotherComplex(msg.receiver)) {
            logger.warn(`다른 단지로 향한 호출을 거부합니다: ${msg.receiver} (이 서버 ${COMPLEX_ID})`);
            // 조용히 버리면 인터폰은 벨이 울리기를 기다리며 매달린다. 알려 준다.
            this.sendError(ws, Error('this server serves another complex'));
            return false;
        }
        // client id is generated within.
        const clientId: number = +this.generateRandomNumber(8);
        this.app.roomTable.inviteClientToRoom(parseInt(msg.roomid), 
                                clientId, msg.sender, msg.device, ws, 
                                (error, initiater) => {
            if (error === RTC_ROOM_TAKEN) {
                // 다른 단말이 먼저 받았다. 오류가 아니라 **정상적인 결과**다.
                //
                // 같은 동/호의 활성 단말 전부에 푸시가 나가므로 여러 대가 동시에
                // 반응할 수 있다. 먼저 온 쪽이 통화를 이어가고, 늦게 온 쪽은
                // 벨을 끄고 화면을 닫아야 한다. 그래서 앱이 이미 다루고 있는
                // 'bye' 로 알린다 — 새 메서드를 만들면 옛 앱이 못 알아듣는다.
                const bye = new ClientMessage();
                bye.method = 'bye';
                bye.roomid = msg.roomid;
                bye.sender = msg.receiver;      /* 방을 만든 쪽 */
                bye.receiver = msg.sender;
                bye.device = msg.device;
                bye.code = '486';               /* SIP 486 Busy Here 와 같은 뜻 */
                bye.extendParam = JSON.stringify({ reason: 'answered-elsewhere' });
                this.safeSend(ws, JSON.stringify(bye));
                logger.info(`room ${msg.roomid} 은 이미 통화 중 — ${msg.sender} 에게 bye(486)`);
                return false;
            }
            if (error) {
                logger.error("error to register on roomTable registration " + error);
                this.safeSend(ws, `ERROR: ${error}`);
                return false;
            }            
            logger.info(`invited to a room - done : initiater ? ${initiater}`);
            if (initiater) {
                logger.info(`now try to send firebase message = ${address}`);
                findAndSendNotificationAsync(address, msg);
            }
            this.safeSend(ws, JSON.stringify({ "method":"update", "clientid": `${clientId}`}));
        });

        return true;
    }
    
    /**
     * @brief Handles RTC client invitation with acknowledgment processing
     * @param ws WebSocket connection from inviting client
     * @param msg ClientMessage containing invitation request details
     * 
     * @details
     * Wrapper method for invitation with acknowledgment handling:
     * - Calls primary invitation handler for client registration
     * - Provides acknowledgment mechanism for invitation confirmation
     * - Handles success/failure responses for invitation attempts
     * - Supports enhanced invitation flow with client feedback
     * - Currently implements basic invitation without additional acknowledgment logic
     * - Placeholder for future acknowledgment protocol extensions
     */
    private _handleRtcInviteClientAndAck(ws: WebSocket, msg: ClientMessage): void {
        if (this._handleRtcInviteClient(ws, msg)) {
            //return this.sendMessage(ws, msg);
        }
        //return this.sendError(ws, Error('failed to register client'));
    }

    /**
     * @brief Removes RTC client from room and validates authorization
     * @param ws WebSocket connection from client requesting removal
     * @param msg ClientMessage containing room and client identification
     * @return boolean true if client successfully removed, false on validation/authorization failure
     * 
     * @details
     * Secure client removal process with comprehensive validation:
     * - Validates required message fields before processing removal
     * - Verifies client is actually joined to the specified room
     * - Prevents unauthorized removal attempts from non-room participants
     * - Removes client from room table maintaining room state consistency
     * - Handles authorization errors with appropriate logging
     * - Essential for proper call termination and room cleanup
     * - Supports both voluntary leave and forced removal scenarios
     */
    private _handleRtcRemoveClient(ws:WebSocket, msg: ClientMessage) : boolean {
        if (!this.validateClientMessage(ws, msg)) {
            return false;
        }

        // 나가는 쪽도 **소켓**으로 정한다.
        //
        // 예전에는 메시지의 clientid 를 그대로 썼다. removeClientIfJoined 가
        // 소켓 일치를 확인하므로 남을 내보내지는 못했지만, 자기 cid 를 잘못
        // 적으면 아무 일도 일어나지 않은 채 성공으로 처리됐다. 그러면 통화를
        // 끊었는데 자리가 남아 다음 착신이 '통화 중' 으로 거부될 수 있다.
        const room = this.app.roomTable.findById(parseInt(msg.roomid));
        const leaving = room ? room.findByWebsocket(ws) : null;
        if (!room || !leaving) {
            logger.warn("client is not joined to the room");
            return false;
        }

        room.removeClientIfJoined(leaving.cid, ws);
        return true;
    }

    
    // ===== IOT MESSAGE HANDLER =====
    
    /**
     * @brief Handles IoT WebSocket messages for device communication
     * @param ws WebSocket connection instance
     * @param req HTTP request object from WebSocket upgrade
     * 
     * @details
     * Sets up message handling for IoT protocol WebSocket connections:
     * - Parses incoming JSON messages and routes by method type
     * - Handles create, modify, join, subscribe, control, status, unsubscribe, error
     * - Manages IoT device registration and room participation
     * - Extracts client IP address for device identification
     * - Provides comprehensive IoT device lifecycle management
     * - Supports smart home and industrial IoT device integration
     */
    private handleIoTMessage(ws: WebSocket, req: Request) { 
        // RTC 쪽과 같은 이유로 예외 경계를 둔다 (safeHandle 주석 참고).
        ws.on('message', (data: WebSocketRawData) => this.safeHandle(ws, 'IOT', () => {
            let json;
            const raw = data.toLocaleString();
            try {
                json = JSON.parse(raw);
            }
            catch (e) {
                return this.sendNotUnderstood(ws, raw);
            }

            if (json.method === undefined) {
                return this.sendError(ws, Error("method field not found"));
            }
            logger.debug('[IOT] message %s (%d bytes)', json.method, raw.length);
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const ipv4 = this.extractIPv4FromMappedIPv6(ip ? ip.toString() : '');
            switch (json.method) {
                case WS_METHODS.CREATE: this._handleIotCreate(ws, json, ipv4); break;
                case WS_METHODS.MODIFY: this._handleIotModify(ws, json); break; // modify is same as create
                case WS_METHODS.JOIN: this._handleIotJoin(ws, json); break;
                case WS_METHODS.SUBSCRIBE: this._handleIotSubscribe(ws, json); break;
                case WS_METHODS.IOT_CONTROL: this._handleIotControl(ws, json); break;
                // async 함수라 안에서 던진 예외는 safeHandle 이 못 잡는다.
                // 거부된 프로미스가 unhandledRejection 으로 새지 않게 여기서 받는다.
                case WS_METHODS.IOT_STATUS:
                    this._handleIotStatusAsync(ws, json).catch((err: any) => {
                        logger.error(`[IOT] status 처리 실패: ${err?.message ?? err}`);
                    });
                    break;
                case WS_METHODS.UNSUBSCRIBE: this._handleIotUnsubscribe(ws, json); break;
                case WS_METHODS.ERROR: this._handleIotError(ws, json); break;
            }
        }));
        ws.once('error', error => {
            ws.close();
        });
        ws.once('close', () => {
            this.app.roomTable.removeClientFromRooms(ws);
        });        
    }

    // ===== IOT METHODS =====
    
    /**
     * @brief Creates new IoT device room or reconnects existing client
     * @param ws WebSocket connection from IoT device
     * @param msg IoTMessage containing room and device information
     * @param ipv4 Optional IPv4 address of the connecting device
     * 
     * @details
     * Handles IoT device room creation and client registration:
     * - Creates new room if it doesn't exist with generated client ID
     * - Reconnects existing client if room and client ID match
     * - Validates room ID presence and handles duplicate registrations
     * - Binds WebSocket connection to client for message routing
     * - Sends success response with room and client details
     * - Integrates with room management system for IoT device lifecycle
     */
    private _handleIotCreate(ws: WebSocket, msg: IoTMessage, ipv4?: string) {
        if (!msg.roomid) {
            // room id to join or create
            this.sendError(ws, Error("invalid create request: missing 'roomid'"));
            return false;
        }

        let room = this.app.roomTable.findById(Number(msg.roomid));
        if(room != null) {
            let client = room.findByCid(Number(msg.clientid));
            if(client == null) {
                logger.warn("[Failed] the room already exists = " + msg.roomid + ", but not the same clientid = " + msg.clientid)
                this.sendError(ws, Error("Room already exists, not the same clientid"));
           } else {
                client.bind(ws);
                logger.info("[Okay] the room already exists = " + msg.roomid + ", with the the same clientid = " + msg.clientid)
                let response : IoTMessage = IoTMessage.build(msg.method, 
                                        msg.roomid, 
                                        msg.clientid, 
                                        '200', 
                                        ''/*client.getIoTPayload()*/);
                // 아래 신규 생성 경로와 같은 방식으로 보낸다.
                client.send(response);
           }
           return;
        }
        const clientid: number = +this.generateRandomNumber(8);
        let client = this.app.roomTable.createRoomForIot(
                                    Number(msg.roomid), 
                                    Number(clientid), 
                                    msg.address, 
                                    ipv4 ? ipv4 : "",
                                    msg.payload, 
                                    ws);
        
        if(client != null) {
            let response : IoTMessage = IoTMessage.build(msg.method, 
                                                msg.roomid, 
                                                clientid, 
                                                '200', 
                                                ''/*client.getIoTPayload()*/);
            client.send(response);
        } else {
            this.sendError(ws, Error("Cannot create client"));
        }
    }

    /**
     * @brief Modifies existing IoT client configuration and payload
     * @param ws WebSocket connection from IoT device
     * @param msg IoTMessage containing modification parameters
     * 
     * @details
     * Updates IoT client properties for existing room participants:
     * - Validates room existence and client authentication
     * - Updates client address and payload information
     * - Verifies WebSocket connection belongs to room participant
     * - Sends success response confirming configuration update
     * - Handles authorization errors for unauthorized modification attempts
     * - Essential for IoT device reconfiguration and state updates
     */
    private _handleIotModify(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid) {
            // room id to join or create
            this.sendError(ws, Error("invalid create request: missing 'roomid'"));
            return false;
        }
        let room = this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error("the room does not exists yet = " + msg.roomid);
            this.sendError(ws, Error("Room not exist"));
            return false;
        }
        if(room.findByWebsocket(ws) != null) {
            let client = room.modifyIoTClient(Number(msg.clientid), msg.address, true, msg.payload);
            if(client) {
                let response : IoTMessage = IoTMessage.build(msg.method, 
                                                            msg.roomid, 
                                                            msg.clientid, 
                                                            '200', 
                                                            "");
                client.send(response);
            } else {
                this.sendError(ws, Error("Cannot modify payload"));
            }
        } else {
            this.sendError(ws, Error("You are not joined to the room"));
        }
    }

    /**
     * @brief Joins IoT client to existing room as participant
     * @param ws WebSocket connection from IoT device
     * @param msg IoTMessage containing room identification
     * 
     * @details
     * Enables IoT device participation in existing rooms:
     * - Validates room existence before allowing join operation
     * - Creates new client instance for device with generated ID
     * - Retrieves initiator payload for device synchronization
     * - Handles both new joins and existing client reconnections
     * - Binds WebSocket connection for real-time communication
     * - Provides initiator data to joining devices for state sync
     * - Logs join operations for room management and debugging
     */
    private _handleIotJoin(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid) {
            // room id to join or create
            this.sendError(ws, Error("invalid join request: missing 'roomid'"));
            return;
        }
        let room  = this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error("the room does not exists yet = " + msg.roomid);
            this.sendError(ws, Error("Room not exist"));
            return;
        }
        let client = room.findByWebsocket(ws);
        if(client === null) {
            const clientId: number = +this.generateRandomNumber(8);
            let client : RtcClient = room.createIotClient(clientId, msg.address, "", /* do not put ipaddress here */
                false, undefined);
            if(client) {
                client.bind(ws);
                let initiater = room.findInitiator();
                let response : IoTMessage = IoTMessage.build(msg.method, 
                                                            msg.roomid, 
                                                            clientId, 
                                                            '200', 
                                                            initiater ? initiater.getIoTPayload() : {});
                client.send(response);
                logger.info(`client ${client.cid} joined to the room ${msg.roomid}`);
            } else {
                this.sendError(ws, Error("Cannot create client"));
            }
        } else {
            let response : IoTMessage = IoTMessage.build(msg.method, 
                                                        msg.roomid, 
                                                        client.cid, 
                                                        '200', 
                                                        client.getIoTPayload());
            client.send(response);
            logger.info(`client ${client.cid} already joined to the room ${msg.roomid}`);
        }
    }

    /**
     * @brief Subscribes IoT client to receive real-time updates from room initiator
     * @param ws WebSocket connection from subscribing IoT device
     * @param msg IoTMessage containing subscription request details
     * 
     * @details
     * Establishes subscription for IoT device status monitoring:
     * - Validates room existence and client membership
     * - Enables subscription flag for real-time update delivery
     * - Forwards subscription request to room initiator for acknowledgment
     * - Sends confirmation response to subscribing client
     * - Facilitates bi-directional communication between devices and controllers
     * - Essential for IoT monitoring and control system functionality
     * - Logs subscription events for system tracking and debugging
     */
    private _handleIotSubscribe(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid) {
            // room id to join or create
            this.sendError(ws, Error("invalid subscribe request: missing 'roomid'"));
            return;
        }
        let room= this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error("the room does not exists yet = " + msg.roomid);
            this.sendError(ws, Error("Room not exist"));
            return false;
        }
        let client = room.findByWebsocket(ws);
        if(client) {
            client.setSubscription(true);
            let response : IoTMessage = IoTMessage.build(msg.method, msg.roomid, client.cid, '200', '');
            client.send(response);

            let initiater = room.findInitiator();
            if(initiater !== null) {
                let request : IoTMessage = IoTMessage.build(msg.method, 
                                                            msg.roomid, 
                                                            initiater.cid, 
                                                            '', 
                                                            msg.payload);
                initiater.send(request);
            }
            logger.info(`subscribed to the room ${msg.roomid} with client ${client.cid}`);
        } else {
            //let response : IoTMessage = IoTMessage.build(msg.method, msg.roomid, msg.clientid, '401', 'client not found');
            this.sendError(ws, Error("You are not joined to the room"));
        }
    }

    /**
     * @brief Sends control commands to IoT room initiator for device management
     * @param ws WebSocket connection from controlling client
     * @param msg IoTMessage containing control command and target information
     * 
     * @details
     * Facilitates IoT device remote control functionality:
     * - Validates room and client ID presence in control request
     * - Locates room initiator (primary controller) for command routing
     * - Routes control messages to initiator without response to sender
     * - Updates message with initiator client ID for proper targeting
     * - Supports smart home and industrial IoT device control scenarios
     * - Provides one-way command transmission for device operation
     * - Logs control operations with timestamp for audit trail
     */
    private _handleIotControl(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid || !msg.clientid) {
            // room id to join or create
            this.sendError(ws, Error("invalid control request: missing 'roomid' | 'clientid'"));
            return;
        }

        let room = this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error("the room is not created yet = " + msg.roomid);
            this.sendError(ws, Error("Room not exist"));
            return;
        }

        // 보낸 쪽이 이 방에 들어와 있는지 확인한다.
        //
        // 예전에는 이 검사가 없어서, 방에 들어가지 않은 소켓이 roomid 만 알면
        // 홈넷 장치에 제어 명령을 넣을 수 있었다 (실제로 재현됨). roomid 는
        // 8자리 숫자다. subscribe · modify · status 는 모두 하고 있던 검사이고,
        // RTC 쪽도 소켓으로 발신자를 정하며 같은 확인을 겸한다. 여기만 빠져 있었다.
        const sender = room.findByWebsocket(ws);
        if (sender === null) {
            logger.warn(`room ${msg.roomid} 에 들어오지 않은 소켓의 iot-control 을 버린다`);
            this.sendError(ws, Error("You are not joined to the room"));
            return;
        }

        // 제어는 홈넷 장치(initiator)로 모은다. forEach 안의 return 은 반복을
        // 멈추지 못하므로, 대상을 먼저 찾고 한 번만 보낸다.
        const controller = room.findInitiator();
        if (controller === null) {
            logger.warn(`room ${msg.roomid} 에 홈넷 장치가 없다 — 제어를 버린다`);
            this.sendError(ws, Error("No controller in the room"));
            return;
        }
        msg.clientid = Number(controller.cid);
        controller.send(msg);
        logger.debug(`send control to ${msg.clientid} in the room ${msg.roomid}`);
        // no response to the client
        return;
    }

    /**
     * @brief Requests status updates from all subscribed IoT devices in room
     * @param ws WebSocket connection from status requesting client
     * @param msg IoTMessage containing status request parameters
     * 
     * @details
     * Orchestrates comprehensive IoT device status collection:
     * - Validates room existence and initiator authorization
     * - Verifies requesting client is the room initiator
     * - Sends status requests to all subscribed devices with delay
     * - Uses time-delayed transmission to prevent network congestion
     * - Supports comprehensive IoT system monitoring and health checks
     * - Handles authorization for status request permissions
     * - Provides asynchronous status collection with controlled timing
     */
    private async _handleIotStatusAsync(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid || !msg.clientid) {
            // room id to join or create
            this.sendError(ws, Error("invalid status request: missing 'roomid' | 'clientid'"));
            return;
        }
        let room = this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error(`the room with \"${msg.roomid}\" is not created yet`);
            this.sendError(ws, Error("Room not exist"));
            return;
        }
        
        let client = room.findByWebsocket(ws);
        if(client === null || !client.initiator) {
            logger.error(`you are not initiator of the room ${msg.roomid}`);
            this.sendError(ws, Error("You are not initiator of the room"));
            return;
        }

        // for (const client of room.clients) {
        //     if (!client[1].initiator && client[1].isSubscribed()) {
        //         msg.clientid = Number(client[1].cid);
        //         client[1].send(msg);
        //         console.log(`${Date.now()} - send status to ${msg.clientid} in the room ${msg.roomid}`);
        //     }
        //     //await new Promise(resolve => setTimeout(resolve, delayMs));
        // }
        await this._handleIotSendStatusWithDelayAsync(room, msg);
        //this will kill the connection - do nohting ::: this.sendError(ws, Error("Client not found in the room"));        
    }

    /**
     * @brief Sends status requests to subscribed clients with configurable delay
     * @param room RtcRoom containing the IoT clients to query
     * @param msg IoTMessage status request to send to each client
     * @param delayMs Delay in milliseconds between each status request (default: 200ms)
     * 
     * @details
     * Implements controlled status request distribution to prevent network flooding:
     * - Iterates through all room clients filtering for subscribed non-initiators
     * - Sends individual status requests with unique client IDs
     * - Applies configurable delay between requests to manage network load
     * - Uses async/await pattern for proper timing control
     * - Prevents overwhelming IoT devices with simultaneous requests
     * - Logs each status request with timestamp for monitoring
     * - Essential for scalable IoT device status monitoring systems
     */
    private async _handleIotSendStatusWithDelayAsync(room: RtcRoom, msg: IoTMessage, delayMs: number = IOT_STATUS_DELAY_MS) {
        let sent = 0;
        for (const client of room.clients) {
            const c = client[1];
            if (c.initiator || !c.isSubscribed()) {
                continue;   // 대상이 아니면 기다리지도 않는다
            }
            // 실제로 보낸 것들 **사이에만** 간격을 둔다. 첫 대상 앞과 마지막
            // 대상 뒤에는 두지 않는다.
            if (sent > 0 && delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            msg.clientid = Number(c.cid);
            c.send(msg);
            sent++;
            logger.debug(`send status to ${msg.clientid} in the room ${msg.roomid}`);
        }
        logger.debug(`room ${msg.roomid}: 상태를 구독 단말 ${sent}대에 보냈다`);
    }

    /**
     * @brief Unsubscribes IoT client from receiving real-time updates
     * @param ws WebSocket connection from unsubscribing IoT device
     * @param msg IoTMessage containing unsubscription request details
     * @return boolean False if validation fails, undefined on success
     * 
     * @details
     * Removes IoT device from active subscription list:
     * - Validates room existence and required message fields
     * - Locates client by WebSocket connection for authentication
     * - Disables subscription flag to stop update delivery
     * - Sends confirmation response to unsubscribing client
     * - Handles authorization errors for non-room participants
     * - Essential for IoT device lifecycle and resource management
     * - Prevents unnecessary message delivery to inactive devices
     */
    private _handleIotUnsubscribe(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid || !msg.clientid) {
            // room id to join or create
            this.sendError(ws, Error("invalid unsubscribe request: missing 'roomid' | 'clientid'"));
            return false;
        }
        let room = this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error("the room does not exists yet = " + msg.roomid);
            this.sendError(ws, Error("Room not exist"));
            return false;
        }
        let client = room.findByWebsocket(ws);
        if(client) {
            client.setSubscription(false);
            let response : IoTMessage = IoTMessage.build(msg.method, msg.roomid, client.cid, '200', '');
            client.send(response);
        } else {
            this.sendError(ws, Error("You are not joined to the room"));
        }        
    }

    /**
     * @brief Broadcasts error messages to all clients in IoT room
     * @param ws WebSocket connection from error reporting client
     * @param msg IoTMessage containing error information to broadcast
     * @return boolean False if validation fails, undefined on success
     * 
     * @details
     * Distributes error notifications across IoT room participants:
     * - Validates room existence and required message fields
     * - Broadcasts error message to all clients in the room
     * - Updates each message with individual client IDs for proper routing
     * - Provides system-wide error notification for IoT device networks
     * - Handles critical error scenarios requiring immediate attention
     * - Essential for IoT system health monitoring and fault tolerance
     * - Ensures all devices are aware of system or device failures
     */
    private _handleIotError(ws: WebSocket, msg: IoTMessage) {
        if (!msg.roomid || !msg.clientid) {
            // room id to join or create
            this.sendError(ws, Error("invalid error request: missing 'roomid' | 'clientid'"));
            return false;
        }
        let room = this.app.roomTable.findById(Number(msg.roomid));
        if(room === null) {
            logger.error("the room does not exists yet = " + msg.roomid);
            this.sendError(ws, Error("Room not exist"));
            return false;
        }
        // iot-control 과 같은 이유로 소속을 확인한다. 이 경로는 방 안의 모든
        // 장치에 뿌리므로, 막지 않으면 roomid 만 아는 쪽이 남의 집 단말 전체에
        // 임의의 오류를 뿌릴 수 있다.
        if (room.findByWebsocket(ws) === null) {
            logger.warn(`room ${msg.roomid} 에 들어오지 않은 소켓의 error 브로드캐스트를 버린다`);
            this.sendError(ws, Error("You are not joined to the room"));
            return false;
        }
        room.clients.forEach((client: RtcClient) => {
            msg.clientid = Number(client.cid);
            client.send(msg);
        });
    }
}

/**
 * @brief Sends targeted Firebase push notifications for visitor invitations
 * @param address Building address identifier for notification targeting
 * @param msg Message object containing invitation details and optional targeting info
 * @return Promise<void> Asynchronous notification sending operation
 * 
 * @details
 * Advanced notification system with email-based targeting:
 * - Queries registered mobile devices for the specified address
 * - Supports email filtering via extendParam JSON parsing for targeted delivery
 * - Creates Korean-localized notification messages for visitors
 * - Uses Firebase Cloud Messaging multicast for efficient delivery
 * - Includes custom sound (doorbell.wav) and notification channel configuration
 * - Handles JSON parsing errors gracefully with fallback to broadcast mode
 * - Logs targeting information and delivery results for monitoring
 * - Essential for smart building intercom and visitor notification systems
 */
async function findAndSendNotificationAsync(address: string, msg: any): Promise<void> {
    let options = {
        priority: "high",
        timeToLive: 60 * 60 * 24
    };
    
    // extendParam 의 targetAgent 가 있으면 그 이메일의 단말에만 보낸다.
    let targetEmail: string | null = null;
    if (msg.extendParam && msg.extendParam.trim() !== '') {
        try {
            const extendData = JSON.parse(msg.extendParam);
            if (extendData.targetAgent && typeof extendData.targetAgent === 'string') {
                targetEmail = extendData.targetAgent;
                logger.info(`Targeting specific email: ${targetEmail}`);
            }
        } catch (error) {
            logger.warn(`Failed to parse extendParam JSON: ${error}`);
            // If JSON parsing fails, proceed without email filtering
        }
    }

    // address 와 email 은 WS 메시지에서 온 값이므로 반드시 바인딩한다.
    // id 와 push_error 를 함께 뽑는다 — 발송 결과를 기본 키로 되쓰기 위해서다
    // (push.ts 참고). token 에는 인덱스가 없어 그 값으로 갱신하면 전체 스캔이 된다.
    //
    // 단지 조건이 붙는 이유: address 는 `1B101U`(동/호)라 **단지 안에서만
    // 유일하다.** 두 단지에 모두 101동 101호가 있다 (libs/complex.ts).
    const c = complexClause();
    const sql = `SELECT id, token, email, push_error FROM ${config.tables.mobile}
                  WHERE address = ? AND active = 1${c.sql}` + (targetEmail ? ` AND email = ?` : ``);
    const params = targetEmail ? [address, ...c.params, targetEmail] : [address, ...c.params];

    let rows: any[];
    try {
        rows = await DbConn.select(sql, params);
    } catch (err: any) {
        logger.error('푸시 대상 조회 실패:', err.message);
        return;
    }

    {
        if (rows.length > 0) {
            // Korean
            let koreanAddress = address
            koreanAddress = koreanAddress.replace('B', '동');
            koreanAddress = koreanAddress.replace('U', '호');

            const message : TokenMessage = {
                token: "",
                notification: {
                    title: `방문자 (${Utils.getDateTime()})`,
                    body: `새로운 방문자가 있습니다.지금 연결하시겠습니까? (${koreanAddress})`,
                },
                data: {
                    method: "invite",
                    sender: `${msg.sender}`, /* any anonymous sender */
                    receiver: `${msg.receiver}`, /* any anonymous receiver */
                    code: "100",
                    device: "interphone",
                    // WebSocket 규약과 같은 철자를 쓴다 (room.ts 의 푸시도 같다).
                    roomid: `${msg.roomid}`
                },
                android: {
                    priority: "high",
                    notification: {
                        channelId: config.firebase.channelId,
                        sound: config.firebase.sound
                    }
                }
            };

            // 키가 없으면 푸시만 건너뛴다. 시그널링은 그대로 진행된다.
            // 무효 토큰 정리는 sendToTargets 안에서 한다.
            const targets: PushTarget[] = rows.map((r) => ({
                id: Number(r.id), token: r.token, push_error: r.push_error,
            }));
            await sendToTargets(targets, message, `방문자 호출 ${address}`);
        }
    }
}

/**
 * Singleton pattern to start the WebSocket server.
 * @param {RelayGateway} callFusion - 실행 중인 릴레이 게이트웨이.
 * @returns {WebSocketServer} - The singleton instance of WebSocketServer.
 */
export function startWebsocketService(callFusion : RelayGateway) : WebSocketServer {
    const service = WebSocketService.createInstance(callFusion);
    return service ? (service as any).rtcServer : null;
}

export default {
    startWebsocketService,
    WebSocketServer
}