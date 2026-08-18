import { Router, Request, Response } from 'express';
import sqlite3 from 'sqlite3';
import logger from '../libs/logger.js';
import { CallFusion } from '../index.js';

const router = Router();
const db = sqlite3.verbose();

// Helper function to get database connection
function getDbConnection() {
    return new db.Database('./cf2rtc-sqlite-db.db', (err: any) => {
        if (err) {
            logger.error('Failed to connect to the database:', err.message);
        }
    });
}

// Interface for Mobile record
interface MobileRecord {
    id?: number;
    uuid: string;
    email: string;
    complex: string;
    address: string;
    token: string;
    active?: boolean;
    created?: string;
}

// CREATE - Add new mobile record
router.post('/', (req: Request, res: Response) => {
    const { uuid, email, complex, address, token, active = true } = req.body;

    if (!uuid || !email || !complex || !address || !token) {
        return res.status(400).json({
            error: 'Missing required fields: uuid, email, complex, address, token'
        });
    }

    const sqliteDb = getDbConnection();
    const created = new Date().toISOString();
    const activeInt = active ? 1 : 0;

    const query = `INSERT INTO ${CallFusion.getTableForMobile()} 
                   (uuid, email, complex, address, token, active, created) 
                   VALUES (?, ?, ?, ?, ?, ?, ?)`;

    sqliteDb.run(query, [uuid, email, complex, address, token, activeInt, created], function(err: any) {
        if (err) {
            logger.error('Error creating mobile record:', err.message);
            sqliteDb.close();
            return res.status(500).json({ error: 'Failed to create mobile record' });
        }

        logger.info(`Mobile record created with ID: ${this.lastID}`);
        sqliteDb.close();
        
        res.status(201).json({
            id: this.lastID,
            uuid,
            email,
            complex,
            address,
            token,
            active,
            created,
            message: 'Mobile record created successfully'
        });
    });
});

// READ - Get all mobile records
router.get('/', (req: Request, res: Response) => {
    const sqliteDb = getDbConnection();
    const { active, limit = 100, offset = 0 } = req.query;

    let query = `SELECT * FROM ${CallFusion.getTableForMobile()}`;
    let params: any[] = [];

    // Filter by active status if provided
    if (active !== undefined) {
        const activeInt = active === 'true' ? 1 : 0;
        query += ' WHERE active = ?';
        params.push(activeInt);
    }

    query += ' ORDER BY created DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));

    sqliteDb.all(query, params, (err: any, rows: any[]) => {
        if (err) {
            logger.error('Error fetching mobile records:', err.message);
            sqliteDb.close();
            return res.status(500).json({ error: 'Failed to fetch mobile records' });
        }

        // Convert active field from integer to boolean
        const records = rows.map(row => ({
            ...row,
            active: row.active === 1
        }));

        sqliteDb.close();
        res.json({
            records,
            total: records.length,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string)
        });
    });
});

// READ - Get mobile record by ID
router.get('/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const sqliteDb = getDbConnection();

    const query = `SELECT * FROM ${CallFusion.getTableForMobile()} WHERE id = ?`;

    sqliteDb.get(query, [id], (err: any, row: any) => {
        if (err) {
            logger.error('Error fetching mobile record:', err.message);
            sqliteDb.close();
            return res.status(500).json({ error: 'Failed to fetch mobile record' });
        }

        if (!row) {
            sqliteDb.close();
            return res.status(404).json({ error: 'Mobile record not found' });
        }

        // Convert active field from integer to boolean
        const record = {
            ...row,
            active: row.active === 1
        };

        sqliteDb.close();
        res.json(record);
    });
});

// READ - Get mobile record by UUID
router.get('/uuid/:uuid', (req: Request, res: Response) => {
    const { uuid } = req.params;
    const sqliteDb = getDbConnection();

    const query = `SELECT * FROM ${CallFusion.getTableForMobile()} WHERE uuid = ?`;

    sqliteDb.get(query, [uuid], (err: any, row: any) => {
        if (err) {
            logger.error('Error fetching mobile record by UUID:', err.message);
            sqliteDb.close();
            return res.status(500).json({ error: 'Failed to fetch mobile record' });
        }

        if (!row) {
            sqliteDb.close();
            return res.status(404).json({ error: 'Mobile record not found' });
        }

        // Convert active field from integer to boolean
        const record = {
            ...row,
            active: row.active === 1
        };

        sqliteDb.close();
        res.json(record);
    });
});

// UPDATE - Update mobile record
router.put('/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { uuid, email, complex, address, token, active } = req.body;
    const sqliteDb = getDbConnection();

    // Build dynamic update query
    const updateFields: string[] = [];
    const params: any[] = [];

    if (uuid !== undefined) {
        updateFields.push('uuid = ?');
        params.push(uuid);
    }
    if (email !== undefined) {
        updateFields.push('email = ?');
        params.push(email);
    }
    if (complex !== undefined) {
        updateFields.push('complex = ?');
        params.push(complex);
    }
    if (address !== undefined) {
        updateFields.push('address = ?');
        params.push(address);
    }
    if (token !== undefined) {
        updateFields.push('token = ?');
        params.push(token);
    }
    if (active !== undefined) {
        updateFields.push('active = ?');
        params.push(active ? 1 : 0);
    }

    if (updateFields.length === 0) {
        sqliteDb.close();
        return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id); // Add ID for WHERE clause

    const query = `UPDATE ${CallFusion.getTableForMobile()} 
                   SET ${updateFields.join(', ')} 
                   WHERE id = ?`;

    sqliteDb.run(query, params, function(err: any) {
        if (err) {
            logger.error('Error updating mobile record:', err.message);
            sqliteDb.close();
            return res.status(500).json({ error: 'Failed to update mobile record' });
        }

        if (this.changes === 0) {
            sqliteDb.close();
            return res.status(404).json({ error: 'Mobile record not found' });
        }

        logger.info(`Mobile record updated: ID ${id}`);
        sqliteDb.close();
        res.json({ message: 'Mobile record updated successfully', id: parseInt(id) });
    });
});

// UPDATE - Toggle active status
router.patch('/:id/toggle-active', (req: Request, res: Response) => {
    const { id } = req.params;
    const sqliteDb = getDbConnection();

    // First get current active status
    const selectQuery = `SELECT active FROM ${CallFusion.getTableForMobile()} WHERE id = ?`;
    
    sqliteDb.get(selectQuery, [id], (err: any, row: any) => {
        if (err) {
            logger.error('Error fetching mobile record for toggle:', err.message);
            sqliteDb.close();
            return res.status(500).json({ error: 'Failed to fetch mobile record' });
        }

        if (!row) {
            sqliteDb.close();
            return res.status(404).json({ error: 'Mobile record not found' });
        }

        const newActiveStatus = row.active === 1 ? 0 : 1;
        const updateQuery = `UPDATE ${CallFusion.getTableForMobile()} SET active = ? WHERE id = ?`;

        sqliteDb.run(updateQuery, [newActiveStatus, id], function(err: any) {
            if (err) {
                logger.error('Error toggling mobile record active status:', err.message);
                sqliteDb.close();
                return res.status(500).json({ error: 'Failed to toggle active status' });
            }

            logger.info(`Mobile record active status toggled: ID ${id}, new status: ${newActiveStatus === 1}`);
            sqliteDb.close();
            res.json({ 
                message: 'Active status toggled successfully',
                id: parseInt(id),
                active: newActiveStatus === 1
            });
        });
    });
});

// DELETE - Delete mobile record (soft delete - set active to false)
router.delete('/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { hard = false } = req.query;
    const sqliteDb = getDbConnection();

    if (hard === 'true') {
        // Hard delete - permanently remove from database
        const query = `DELETE FROM ${CallFusion.getTableForMobile()} WHERE id = ?`;
        
        sqliteDb.run(query, [id], function(err: any) {
            if (err) {
                logger.error('Error deleting mobile record:', err.message);
                sqliteDb.close();
                return res.status(500).json({ error: 'Failed to delete mobile record' });
            }

            if (this.changes === 0) {
                sqliteDb.close();
                return res.status(404).json({ error: 'Mobile record not found' });
            }

            logger.info(`Mobile record permanently deleted: ID ${id}`);
            sqliteDb.close();
            res.json({ message: 'Mobile record permanently deleted', id: parseInt(id) });
        });
    } else {
        // Soft delete - set active to false
        const query = `UPDATE ${CallFusion.getTableForMobile()} SET active = 0 WHERE id = ?`;
        
        sqliteDb.run(query, [id], function(err: any) {
            if (err) {
                logger.error('Error soft deleting mobile record:', err.message);
                sqliteDb.close();
                return res.status(500).json({ error: 'Failed to delete mobile record' });
            }

            if (this.changes === 0) {
                sqliteDb.close();
                return res.status(404).json({ error: 'Mobile record not found' });
            }

            logger.info(`Mobile record soft deleted: ID ${id}`);
            sqliteDb.close();
            res.json({ message: 'Mobile record deactivated', id: parseInt(id) });
        });
    }
});

// GET - Statistics
router.get('/stats/summary', (req: Request, res: Response) => {
    const sqliteDb = getDbConnection();
    
    const queries = {
        total: `SELECT COUNT(*) as count FROM ${CallFusion.getTableForMobile()}`,
        active: `SELECT COUNT(*) as count FROM ${CallFusion.getTableForMobile()} WHERE active = 1`,
        inactive: `SELECT COUNT(*) as count FROM ${CallFusion.getTableForMobile()} WHERE active = 0`,
        recent: `SELECT COUNT(*) as count FROM ${CallFusion.getTableForMobile()} 
                 WHERE created > datetime('now', '-7 days')`
    };

    const stats: any = {};
    let completedQueries = 0;
    const totalQueries = Object.keys(queries).length;

    Object.entries(queries).forEach(([key, query]) => {
        sqliteDb.get(query, [], (err: any, row: any) => {
            if (err) {
                logger.error(`Error getting ${key} stats:`, err.message);
                stats[key] = 0;
            } else {
                stats[key] = row.count;
            }

            completedQueries++;
            if (completedQueries === totalQueries) {
                sqliteDb.close();
                res.json({
                    total: stats.total || 0,
                    active: stats.active || 0,
                    inactive: stats.inactive || 0,
                    recentlyAdded: stats.recent || 0,
                    timestamp: new Date().toISOString()
                });
            }
        });
    });
});

export default router;