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
import { CallFusion } from '../index';
import { DbConn } from '../libs/dbConnection';
import logger from '../libs/logger'; // Import your configured logger

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
 * 
 * @return JSON response with success/error status
 */
async function handlePostMobile(req: Request, res: Response) {
    const { uuid, email, complex, address, token } = req.body ?? {};
    if (!uuid || !email || !complex || !address || !token) {
        res.status(400).json({ error: 'uuid, email, complex, address, token 은 필수입니다.' });
        return;
    }

    // uuid 에 UNIQUE 가 걸려 있어 조회 없이 한 번으로 끝난다.
    // (이관 전에는 SELECT COUNT → INSERT 또는 UPDATE 3단계였다)
    const sql = `INSERT INTO ${CallFusion.getTableForMobile()}
                    (uuid, email, complex, address, token, phone, image)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    email = VALUES(email), complex = VALUES(complex), address = VALUES(address),
                    token = VALUES(token), phone = VALUES(phone), image = VALUES(image)`;

    try {
        const result = await DbConn.execute(sql, [
            uuid, email, complex, address, token,
            req.body.phone ?? null, req.body.image ?? null,
        ]);
        // affectedRows: 1 = 새로 넣음, 2 = 갱신함
        const created = result.affectedRows === 1;
        logger.info(`mobile ${created ? 'registered' : 'updated'}: ${uuid}`);
        res.status(200).json({
            title: 'rtc-relay-server',
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
    const sql = `INSERT INTO ${CallFusion.getTableForHomenet()}
                    (complex, type, building, unit, ipaddress)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    type = VALUES(type), ipaddress = VALUES(ipaddress)`;

    try {
        const result = await DbConn.execute(sql, [complex, type, building, unit, ipaddress]);
        const created = result.affectedRows === 1;
        logger.info(`homenet ${created ? 'registered' : 'updated'}: ${complex}/${building}/${unit}`);
        res.status(200).json({
            title: 'rtc-relay-server',
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
 * 1. Validates CallFusion instance availability
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
 * - Error (500): "CallFusion instance not found"
 * 
 * @note Used for real-time device discovery in active communication sessions
 */
function handleFindIp(req: Request, res: Response) {
    let peerAddress = req.query.address as string;
    let callFusion = CallFusion.getInstance();
    if (!callFusion) {
        res.status(500).send("CallFusion instance not found");
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
    for (let room of callFusion.roomTable.roomTable.values()) {
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