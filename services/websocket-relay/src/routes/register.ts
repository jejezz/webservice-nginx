/**
 * @file register.ts
 * @brief Device registration routes for mobile and home network devices
 * @author jyahn
 * @date 2022-04-14
 * @version 1.0.0
 * 
 * @description
 * This module handles device registration endpoints for the CallFusion system.
 * It provides REST API endpoints for:
 * - Mobile device registration with Firebase tokens
 * - Home network device (complex agents) registration
 * - IP address discovery for IoT and RTC devices
 * 
 * The registration system supports both SQLite database operations for
 * persistent storage and real-time device lookup in active rooms.
 * 
 * @note Original description: Mobile Registration 을 담당한다.
 */

import express, { Request, Response, NextFunction } from 'express';
import config from '../config';
import { getGateway } from '../gateway';
import { DbConn } from '../libs/dbConnection';
import logger from '../libs/logger'; // Import your configured logger
import { normalizeSipUser, SIP_USER_ERROR } from '../libs/sipUser';
import { COMPLEX_ID, COMPLEX_ID_RE, COMPLEX_ID_ERROR } from '../libs/complex';

/** @brief Express router instance for registration endpoints */
const Route2Register = express.Router();

/**
 * @brief Middleware for logging incoming registration requests
 * @param req Express request object
 * @param res Express response object  
 * @param next Next middleware function
 * 
 * @details
 * Logs all incoming requests to the registration module with timestamp
 * for debugging and monitoring purposes.
 */
Route2Register.use(function timeLog(req: Request, res: Response, next: NextFunction) {
    logger.info(`[register] ------ new request [ ${Date.now()} ]------`);
    next();
});

/**
 * @brief POST endpoint for mobile device registration
 * @details Handles mobile device registration with Firebase tokens
 * @route POST /register/mobile
 */
Route2Register.post('/mobile', function (req: Request, res: Response) {
    handlePostMobile(req, res);
});

/**
 * @brief POST endpoint for home network device registration
 * @details Handles complex/building/unit based device registration
 * @route POST /register/complex_agents
 */
Route2Register.post('/complex_agents', function (req: Request, res: Response) {
    handlePostComplexAgents(req, res);
});

/**
 * @brief GET endpoint for module information
 * @details Returns basic information about the registration module
 * @route GET /register/about
 */
Route2Register.get('/about', function (req: Request, res: Response) {
    res.send('this is registration module');
});

/**
 * @brief GET endpoint for IP address discovery
 * @details Finds IP address of devices by their address identifier
 * @route GET /register/findip?address=<device_address>
 */
Route2Register.get('/findip', function (req: Request, res: Response) {
    handleFindIp(req, res);
});

/**
 * @brief Handles mobile device registration requests
 * @param req Express request object containing device registration data
 * @param res Express response object for sending results
 * 
 * @details
 * Processes mobile device registration with the following steps:
 * 1. Creates timestamp for registration/update
 * 2. Checks if device already exists using UUID
 * 3. Inserts new device or updates existing device information
 * 4. Stores UUID, email, complex, address, Firebase token, and timestamp
 * 
 * Expected request body:
 * - uuid: Device unique identifier
 * - email: User email address  
 * - complex: Building/complex information
 * - address: Device address
 * - token: Firebase push notification token
 * - sip_user: (선택) SIP 내선. 인터폰 착신 푸시 대상 조회에 쓴다
 * 
 * @return JSON response with success/error status
 */

async function handlePostMobile(req: Request, res: Response) {
    const { uuid, email, complex, address, token } = req.body ?? {};
    if (!uuid || !email || !complex || !address || !token) {
        res.status(400).json({ error: 'uuid, email, complex, address, token 은 필수입니다.' });
        return;
    }

    /*
     * complexId — 이 등록이 **이 서버로 올 것이 맞는지** 본다.
     *
     * 앱은 앱스토어에서 한 벌로 배포되고 단지 정보를 디렉터리에서 받아 오므로,
     * 잘못된 단지를 고르면 엉뚱한 서버로 등록을 보낼 수 있다. 그걸 여기서
     * 잡는다. 단지 ID 는 앱을 깐 누구나 알 수 있는 값이라 **인증이 아니다** —
     * 오배송을 막는 안전망이다 (libs/complex.ts).
     *
     *   서버에 COMPLEX_ID 없음  → 검사하지 않는다 (단지가 하나인 지금 배치)
     *   앱이 안 보냄            → 이 서버 값으로 채운다 (옛 앱 호환)
     *   보냈는데 다름           → 403. 조용히 받아 두면 그 단말은 영영 전화를
     *                              못 받는다 — 대상 조회가 단지로도 거르기 때문
     */
    const rawComplexId = req.body?.complexId ?? req.body?.complex_id;
    let complexId: string | null = COMPLEX_ID;
    if (rawComplexId !== undefined && rawComplexId !== null && String(rawComplexId).trim() !== '') {
        const v = String(rawComplexId).trim().toLowerCase();
        if (!COMPLEX_ID_RE.test(v)) {
            res.status(400).json({ error: COMPLEX_ID_ERROR });
            return;
        }
        if (COMPLEX_ID && v !== COMPLEX_ID) {
            logger.warn(`단지가 다른 등록을 거부했습니다: 보낸 값 ${v}, 이 서버 ${COMPLEX_ID}`);
            res.status(403).json({
                error: 'complex_mismatch',
                message: '이 서버가 맡은 단지가 아닙니다. 앱에서 단지를 다시 선택하세요.',
            });
            return;
        }
        complexId = v;
    }

    /*
     * sip_user — 인터폰 착신 푸시가 이 단말을 찾는 열쇠다 (schema/002-sip-user.sql).
     *
     * 세 가지를 구분한다.
     *   보내지 않음   → null → **기존 값을 건드리지 않는다** (아래 COALESCE)
     *   빈 문자열     → '' 로 저장 = 연결 해제. 착신 조회에 걸리지 않는다
     *   값이 있음     → 형식을 보고 저장
     *
     * 안 보낸 것을 '지움' 으로 다루면, 이 필드를 모르는 옛 앱이 갱신할 때마다
     * 연결이 조용히 끊긴다. 그래서 '건드리지 않음' 을 기본으로 둔다.
     */
    const parsed = normalizeSipUser(req.body?.sip_user);
    if (!parsed.ok) {
        res.status(400).json({ error: SIP_USER_ERROR });
        return;
    }
    const sipUser = parsed.value;

    // uuid 에 UNIQUE 가 걸려 있어 조회 없이 한 번으로 끝난다.
    // (이관 전에는 SELECT COUNT → INSERT 또는 UPDATE 3단계였다)
    // sip_user 만 COALESCE 로 받는다 — 안 보냈을 때(null) 기존 값을 지우지 않기 위해서다.
    /*
     * 토큰이 **바뀌었을 때만** 건강 상태를 손본다 (schema/003-push-health.sql).
     *
     *   active      FCM 이 "모르는 토큰" 이라고 해서 자동으로 내려간 행만 되살린다.
     *               사람이 대시보드에서 내린 행은 push_error 가 NULL 이므로 그대로
     *               둔다 — 앱이 다시 등록한다고 관리자의 판단을 뒤집으면 안 된다.
     *   push_error  새 토큰에는 옛 실패 코드가 의미가 없으니 지운다.
     *
     * ⚠️ 대입 순서가 중요하다. MySQL 은 ON DUPLICATE KEY UPDATE 의 대입을 왼쪽부터
     *    차례로 적용하므로, `token` 을 덮어쓰기 **전에** 옛 값을 참조하는 식들을
     *    먼저 둬야 한다. active 도 push_error 를 지우기 전에 읽어야 한다.
     */
    const sql = `INSERT INTO ${config.tables.mobile}
                    (uuid, email, complex, complex_id, address, token, phone, image, sip_user, token_updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    active = IF(VALUES(token) <> token AND push_error IS NOT NULL, 1, active),
                    push_error = IF(VALUES(token) <> token, NULL, push_error),
                    push_failed_at = IF(VALUES(token) <> token, NULL, push_failed_at),
                    token_updated_at = IF(VALUES(token) <> token, NOW(), token_updated_at),
                    token = VALUES(token),
                    email = VALUES(email), complex = VALUES(complex), address = VALUES(address),
                    complex_id = COALESCE(VALUES(complex_id), complex_id),
                    phone = VALUES(phone), image = VALUES(image),
                    sip_user = COALESCE(VALUES(sip_user), sip_user)`;

    try {
        const result = await DbConn.execute(sql, [
            uuid, email, complex, complexId, address, token,
            req.body.phone ?? null, req.body.image ?? null, sipUser,
        ]);
        // affectedRows: 1 = 새로 넣음, 2 = 갱신함
        const created = result.affectedRows === 1;
        logger.info(`mobile ${created ? 'registered' : 'updated'}: ${uuid}`);
        res.status(200).json({
            title: 'websocket-relay',
            result: 'success',
            message: created ? 'Your token has been saved successfully.'
                             : 'Your token has been updated successfully.',
        });
    } catch (err: any) {
        logger.error('mobile 등록 실패:', err.message);
        res.status(500).json({ error: 'registration failed' });
    }
}

/**
 * @brief Handles home network device (complex agents) registration requests
 * @param req Express request object containing device registration data
 * @param res Express response object for sending results
 * 
 * @details
 * Processes home network device registration for complex/building/unit based systems:
 * 1. Creates timestamp for registration/update
 * 2. Checks if device already exists using complex+building+unit combination
 * 3. Inserts new device or updates existing device information
 * 4. Stores complex, type, building, unit, IP address, and timestamp
 * 
 * Expected request body:
 * - complex: Complex/building complex identifier
 * - type: Device type identifier
 * - building: Building identifier within complex
 * - unit: Unit/apartment identifier within building
 * - ipaddress: IP address of the device
 * 
 * @return JSON response with success/error status
 */
async function handlePostComplexAgents(req: Request, res: Response) {
    const { complex, type, building, unit, ipaddress } = req.body ?? {};
    if (!complex || !type || !building || !unit || !ipaddress) {
        res.status(400).json({ error: 'complex, type, building, unit, ipaddress 는 필수입니다.' });
        return;
    }

    // (complex, building, unit) 에 UNIQUE 가 걸려 있다.
    const sql = `INSERT INTO ${config.tables.homenet}
                    (complex, type, building, unit, ipaddress)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    type = VALUES(type), ipaddress = VALUES(ipaddress)`;

    try {
        const result = await DbConn.execute(sql, [complex, type, building, unit, ipaddress]);
        const created = result.affectedRows === 1;
        logger.info(`homenet ${created ? 'registered' : 'updated'}: ${complex}/${building}/${unit}`);
        res.status(200).json({
            title: 'websocket-relay',
            result: 'success',
            message: created ? 'Your registration has been saved successfully.'
                             : 'Your registration has been updated successfully.',
        });
    } catch (err: any) {
        logger.error('homenet 등록 실패:', err.message);
        res.status(500).json({ error: 'registration failed' });
    }
}

/**
 * @brief Finds IP address of a device by its address identifier
 * @param req Express request object with address query parameter
 * @param res Express response object for sending IP address or error
 * 
 * @details
 * Searches for a device's IP address across all active rooms and clients:
 * 1. 게이트웨이가 떠 있는지 확인
 * 2. Extracts and processes the address parameter
 * 3. Removes protocol prefixes ("iot:" or "rtc:")  
 * 4. Strips suffix after "@" symbol if present
 * 5. Searches all rooms and clients for matching address
 * 6. Returns IP address and address if found
 * 
 * Query parameters:
 * - address: Device address identifier (may include "iot:" or "rtc:" prefix)
 * 
 * Response formats:
 * - Success (200): { address: string, ipaddress: string }
 * - Error (401): Error message string
 * - Error (503): "relay gateway is not ready"
 * 
 * @note Used for real-time device discovery in active communication sessions
 */
function handleFindIp(req: Request, res: Response) {
    let peerAddress = req.query.address as string;
    const gateway = getGateway();
    if (!gateway) {
        res.status(503).send("relay gateway is not ready");
        return;
    }
    if ( !peerAddress) {
        res.status(401).send("invalid find-ip request: missing 'address'");
        return;
    }        
    if(peerAddress.startsWith("iot:")) {
        peerAddress = peerAddress.replace("iot:", ""); // remove the "iot:" prefix if it exists
    }
    else if(peerAddress.startsWith("rtc:")) {
        peerAddress = peerAddress.replace("rtc:", ""); // remove the "rtc:" prefix if it exists
    }
    const atIndex = peerAddress.indexOf('@');
    // If "@" is found (atIndex is not -1), return the substring before it
    if (atIndex !== -1) {
        peerAddress = peerAddress.substring(0, atIndex);
    } 
    // Check all the rooms from roomTable
    for (let room of gateway.roomTable.roomTable.values()) {
        // Check all the clients in the room
        for (let client of room.clients.values()) {
            // If the client has the same address as the one in the message
            if (client.getAddress() === peerAddress) {
                // Create a response message with the client's IP address
                const response = {
                    address: client.getAddress(),
                    ipaddress: client.ipaddress
                };
                res.status(200).send(response);
                logger.info("found IP address for " + peerAddress + " : " + client.ipaddress);
                return;
            }
        }
    }
    let errorMessage = "cannot find IP address for " + peerAddress;
    res.status(401).send(errorMessage);
    logger.error(errorMessage);
}


/**
 * @brief Commented out user listing endpoint (legacy code)
 * @details This endpoint would retrieve all mobile device registrations
 * from the database. Currently disabled but preserved for reference.
 * 
 * @code
 * router.get('/users', function(req, res) {
 *     db.connect();
 *     const sql = `SELECT * FROM rtc_mobiles`;
 *     db.query(sql, function(error, rows, fields) {
 *         if(error) throw error;
 *         res.send(rows);
 *     });
 *     db.end();
 * });
 * @endcode
 */
// router.get('/users', function(req, res) {
//     db.connect();
//     const sql = `SELECT * FROM rtc_mobiles`;
//     //console.log('sql: ', sql);
//     db.query(sql, function(error, rows, fields) {
//         if(error) throw error;
//         res.send(rows);
//     });
//     db.end();
// });

/** @brief Export the registration router for use in main application */
export default Route2Register;