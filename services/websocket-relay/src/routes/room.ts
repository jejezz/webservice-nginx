/**
 * @file room.ts
 * @brief Room management routes for RTC communication and invitation system
 * @author jyahn
 * @date 2022-04-14
 * @version 1.0.0
 * 
 * @description
 * This module handles room-related operations for the CallFusion system.
 * It provides REST API endpoints for:
 * - Room invitation system with Firebase push notifications
 * - Mobile device notification for incoming calls/visitors
 * - Room ID generation for communication sessions
 * - Integration with interphone and doorbell systems
 * 
 * The system supports Korean localization for address formatting and
 * uses Firebase Cloud Messaging for real-time push notifications to
 * registered mobile devices.
 * 
 * @note Original description: RtcRoom 을 Control한다.???
 */

import express, { Request, Response, NextFunction } from 'express';
import config from '../config';
import { sendToTargets, PushTarget } from '../libs/push';
import { complexClause } from '../libs/complex';
import { Utils } from '../libs/utils';
import { DbConn } from '../libs/dbConnection';
import { TokenMessage } from 'firebase-admin/messaging';
import logger from '../libs/logger'; // Import your configured logger

/** @brief Express router instance for room management endpoints */
const Route2Room = express.Router();

/** 
 * @brief Firebase messaging options configuration
 * @details Default options for Firebase Cloud Messaging including
 * high priority delivery and 24-hour time-to-live for notifications
 */
let options = {
    priority: "high",
    timeToLive: 60 * 60 * 24
};

/**
 * @brief Middleware for logging incoming room requests
 * @param req Express request object
 * @param res Express response object  
 * @param next Next middleware function
 * 
 * @details
 * Logs all incoming requests to the room management module with timestamp
 * for debugging and monitoring purposes.
 */
Route2Room.use(function timeLog(req:Request, res:Response, next:NextFunction) {
    logger.info(`[register] ------ new request [ ${Date.now()} ]------`);
    next();
});

/**
 * @brief POST endpoint for room invitation with push notifications
 * @details Handles room invitation requests and sends Firebase notifications
 * @route POST /room/invite
 */
Route2Room.post('/invite', function (req:Request, res:Response) {
    handlePostInvite(req, res);
})

/**
 * @brief GET endpoint for room status information
 * @details Returns basic room information by room ID
 * @route GET /room/:roomId
 */
Route2Room.get('/:roomId', function (req:Request, res:Response) {
    res.send(`You are in ${req.params.roomId}`);
});


/**
 * @brief Generates a random room identifier
 * @param len Length of the room ID to generate
 * @return string Random numeric room identifier
 * 
 * @details
 * Creates a random room ID consisting of numeric digits for use in
 * RTC communication sessions. Each room ID is used to uniquely
 * identify a communication session between devices.
 * 
 * @note There's a bug in the implementation - should use 'len' instead of 'length'
 */
function generateRandomRoom(len: number): string {
    let no = '';
    for (let i = 0; i < len; i++) {
        no += Math.floor((Math.random() * 10));
    }
    return no;
}

/**
 * @brief Handles room invitation requests with Firebase push notifications
 * @param req Express request object containing invitation data
 * @param res Express response object for sending results
 * 
 * @details
 * Processes room invitation requests from interphone/doorbell systems:
 * 1. Validates required parameters (target and source addresses)
 * 2. Generates a random 8-digit room ID for the session
 * 3. Queries database for Firebase tokens of target devices
 * 4. Formats Korean address display (B→동, U→호)
 * 5. Sends Firebase push notifications to all registered devices
 * 6. Includes room invitation data for mobile app handling
 * 
 * Expected request body:
 * - target: Target device address to invite
 * - source: Source device address (caller identification)
 * 
 * Firebase notification includes:
 * - Korean localized title and body
 * - RTC connection parameters
 * - Room ID for session establishment
 * - Android-specific sound and channel configuration
 * 
 * @return HTTP status 200 on success, 400/401 on validation errors
 */
/**
 * @brief 주소를 WebSocket 규약의 rtc:<주소>@<호스트> 형식으로 만든다.
 *
 * @details
 * 서버의 getAddressFrom() 은 'rtc:' 와 '@' 사이만 잘라 쓴다. '@' 가 없으면
 * substring(4, -1) 이 되어 빈 문자열이 나오므로 호스트 부분이 반드시 있어야 한다.
 * 호스트 값 자체는 서버가 버리지만, 단말이 되돌려 보낼 때 그대로 실려 오므로
 * 요청이 들어온 호스트를 쓴다.
 *
 * 이미 rtc:...@... 형식으로 온 값은 그대로 둔다.
 */
function rtcAddress(address: string, req: Request): string {
    const value = String(address ?? '').trim();
    if (value.startsWith('rtc:') && value.includes('@')) return value;

    const host = req.headers.host || req.hostname || 'localhost';
    return `rtc:${value.replace(/^rtc:/, '')}@${host}`;
}

async function handlePostInvite(req: Request, res: Response) {
    if (req.body.target === undefined) {
        res.sendStatus(400);
        return;
    }
    else if (req.body.source === undefined) {
        res.sendStatus(401);
        return;
    }

    let roomId = generateRandomRoom(8);

    let rows: any[];
    try {
        // active 인 단말만 부른다. 해제된 단말에 푸시를 보내면 FCM 이 무효 토큰으로 응답한다.
        // id 와 push_error 를 함께 뽑는다 — 발송 결과를 기본 키로 되쓰기 위해서다
        // (libs/push.ts 참고). token 에는 인덱스가 없다.
        // 단지 조건은 address 가 단지 안에서만 유일하기 때문이다 (libs/complex.ts).
        const c = complexClause();
        rows = await DbConn.select(
            // can_call — 이 세대가 인정한 단말만 (libs/enrollment.ts).
            `SELECT id, token, push_error FROM ${config.tables.mobile}
              WHERE address = ? AND active = 1 AND can_call = 1${c.sql}`,
            [req.body.target, ...c.params]);
    } catch (err: any) {
        logger.error('초대 대상 조회 실패:', err.message);
        res.status(500).json({ error: 'query failed' });
        return;
    }

    {

        /**
         * @brief Korean address localization
         * @details Converts building/unit notation to Korean characters:
         * - 'B' (Building) → '동' (dong)
         * - 'U' (Unit) → '호' (ho)
         * This provides user-friendly Korean display in notifications
         */
        // Korean
        let koreanAddress = req.body.source;
        koreanAddress = koreanAddress.replace('B', '동');
        koreanAddress = koreanAddress.replace('U', '호');

        /**
         * @brief Firebase push notification message structure
         * @details Complete notification payload including:
         * - Korean localized title with timestamp
         * - Korean message asking user to accept the call
         * - RTC connection parameters for call establishment
         * - Android-specific configuration for sound and channel
         */
        const message : TokenMessage = {
            token: "",
            notification: {
                title: `방문자 (${Utils.getDateTime()})`,
                body: `새로운 방문자가 있습니다.지금 연결하시겠습니까? ${koreanAddress}`
            },
            data: {
                method: "invite",
                // 요청에서 온 실제 주소를 싣는다. 이전에는 고정 문자열이 박혀 있어
                // 누가 걸든 같은 두 주소가 전달됐다.
                sender: rtcAddress(req.body.source, req),
                receiver: rtcAddress(req.body.target, req),
                code: "100",
                device: "interphone",
                // WebSocket 규약과 같은 철자를 쓴다. 이전에는 여기만 roomId 였고
                // 단말이 두 철자를 모두 다뤄야 했다.
                roomid: `${roomId}`
            },
            android: {
                priority: "high",
                notification: {
                    channelId: "callfusion_2_rtc",
                    sound: "doorbell.wav"
                }
            }
        };   
        /**
         * @brief 등록된 단말들에 초대 푸시를 보낸다.
         * @details 키가 없으면 푸시만 건너뛴다 — 방 생성과 응답은 그대로 진행된다.
         *          FCM 이 모르는 토큰(앱 삭제·재설치)은 sendToTargets 가 비활성으로
         *          내린다. 예전에는 successCount 만 남기고 개별 결과를 버려서
         *          죽은 토큰이 영구히 쌓였다.
         */
        const targets: PushTarget[] = rows.map((r) => ({
            id: Number(r.id), token: r.token, push_error: r.push_error,
        }));
        // 발송을 걸어 두고 바로 답한다. 부르는 쪽을 붙들 이유가 없다.
        void sendToTargets(targets, message, `초대 ${req.body.target}`);

        res.sendStatus(200);
    }
}

/** @brief Export the room management router for use in main application */
export default Route2Room;