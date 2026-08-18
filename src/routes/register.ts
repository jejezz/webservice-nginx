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
import { MysqlError } from 'mysql';
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
    const d = new Date();
    let datestring = d.getFullYear() + "-" + (d.getMonth() + 1)
        + "-" + d.getDate() + " " + d.getHours() + ":" + d.getMinutes() + ":" + d.getSeconds();

    const findQry = `SELECT COUNT(*) AS cnt FROM ${CallFusion.getTableForMobile()} WHERE uuid="${req.body.uuid}"`;
    let db = await DbConn.createSqlConnection();
    DbConn.sqlSelect(db, findQry, function (error:any, rows:any, fields:any) {
        if (error) {
            console.log(error);
            res.status(401).send(error);
            return;
        }
        if (!rows) {
            console.log("table not found");
            res.status(401).send("table not found");
            return;
        }
        console.log("mobile devices - results = ", rows[0].cnt);
        //console.log("firebase token = ", req.body.token);
        if (rows[0].cnt == 0) {
            const insertQry = `INSERT INTO ${CallFusion.getTableForMobile()}(uuid, email, complex, address, token, phone, image, created) 
                values("${req.body.uuid}", "${req.body.email}", "${req.body.complex}" , "${req.body.address}", "${req.body.token}", "${req.body.phone || ''}", "${req.body.image || ''}", "${datestring}")`;
            DbConn.sqlQuery(db, insertQry, function (error:any, results:any, fields:any) {
                if (error) {
                    console.log(error);
                    res.status(401).send(error);
                    return;
                }
                res.status(200).send(`{ 
                    title: "CallFusion2RTC",
                    result: "success",
                    message: "Your token has been saved successfully." 
                }`);
            });
        }
        else {
            const updateQry = `UPDATE ${CallFusion.getTableForMobile()} SET email="${req.body.email}", address="${req.body.address}", complex="${req.body.complex}",
                token="${req.body.token}", phone="${req.body.phone || ''}", image="${req.body.image || ''}", created="${datestring}" WHERE uuid="${req.body.uuid}"`;
            DbConn.sqlQuery(db, updateQry, function (error:any, results:any, fields:any) {
                if (error) {
                    console.log(error);
                    res.status(401).send(error);
                    return;
                }
                res.status(200).send(`{ 
                    title: "CallFusion2RTC",
                    result: "success",
                    message: "Your token has been updated successfully." 
                }`);
            });
        }
    });
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
    
    const d = new Date();
    let datestring = d.getFullYear() + "-" + (d.getMonth() + 1)
        + "-" + d.getDate() + " " + d.getHours() + ":" + d.getMinutes() + ":" + d.getSeconds();

    const findQry = `SELECT COUNT(*) AS cnt FROM ${CallFusion.getTableForHomenet()} WHERE complex="${req.body.complex}" AND building="${req.body.building}" AND unit="${req.body.unit}"`;
    let db = await DbConn.createSqlConnection();
    DbConn.sqlSelect(db, findQry, function (error:MysqlError, rows:any, fields:any) {
        if (error) throw error;
        if (!rows) return;
        console.log("select results = ", rows[0].cnt);
        if (rows[0].cnt == 0) {
            const insertQry = `INSERT INTO ${CallFusion.getTableForHomenet()}(complex, type, building, unit, ipaddress, created) 
                values("${req.body.complex}", "${req.body.type}", "${req.body.building}", "${req.body.unit}", "${req.body.ipaddress}", "${datestring}")`;
            DbConn.sqlQuery(db, insertQry, function (error:any, results:any, fields:any) {
                if (error) {
                    console.log(error);
                    res.status(401).send(error);
                    return;
                }
                res.status(200).send(`{ 
                    title: "CallFusion2RTC",
                    result: "success",
                    message: "Your registration has been saved successfully." 
                }`);
            });
        }
        else {
            const updateQry = `UPDATE ${CallFusion.getTableForHomenet()} SET type="${req.body.type}", ipaddress="${req.body.ipaddress}",
                modified="${datestring}" WHERE complex="${req.body.complex}" AND building="${req.body.building}" AND unit="${req.body.unit}"`;
            DbConn.sqlQuery(db, updateQry, function (error:any, results:any, fields:any) {
                if (error) {
                    console.log(error);
                    res.status(401).send(error);
                    return;
                }
                res.status(200).send(`{ 
                    title: "CallFusion2RTC",
                    result: "success",
                    message: "Your registration has been updated successfully." 
                }`);
            });
        }
    });
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