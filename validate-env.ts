#!/usr/bin/env node

/**
 * Environment Configuration Validator for CallFusion Server
 * 
 * This script validates your environment configuration and checks for potential issues.
 * Run this before starting the server to ensure proper setup.
 * 
 * Usage: npx tsx validate-env.ts
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

interface ValidationResult {
    valid: boolean;
    message: string;
    severity: 'error' | 'warning' | 'info';
}

class EnvironmentValidator {
    private results: ValidationResult[] = [];

    /**
     * Add validation result
     */
    private addResult(valid: boolean, message: string, severity: 'error' | 'warning' | 'info' = 'error'): void {
        this.results.push({ valid, message, severity });
    }

    /**
     * Validate port configuration
     */
    private validatePort(): void {
        const port = process.env.HTTPS_PORT;
        if (!port) {
            this.addResult(true, 'HTTPS_PORT not set, using default 28090', 'info');
        } else {
            const portNum = parseInt(port);
            if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                this.addResult(false, `Invalid HTTPS_PORT: ${port}. Must be between 1-65535`);
            } else if (portNum < 1024) {
                this.addResult(true, `HTTPS_PORT ${port} requires root privileges`, 'warning');
            } else {
                this.addResult(true, `HTTPS_PORT: ${port}`, 'info');
            }
        }
    }

    /**
     * Validate certificate files
     */
    private validateCertificates(): void {
        const certPaths = [
            { env: 'SSL_PRIVATE_KEY_PATH', default: './src/certs/server.key', name: 'Private Key' },
            { env: 'SSL_CERTIFICATE_PATH', default: './src/certs/renewed_server.crt', name: 'Certificate' },
            { env: 'SSL_CA_PATH', default: './src/certs/intermediate-ca.crt', name: 'CA Certificate' }
        ];

        certPaths.forEach(cert => {
            const certPath = process.env[cert.env] || cert.default;
            if (fs.existsSync(certPath)) {
                this.addResult(true, `${cert.name} found: ${certPath}`, 'info');
            } else {
                this.addResult(false, `${cert.name} not found: ${certPath}`);
            }
        });

        // Check longlive certificates
        const longlivePaths = [
            { env: 'SSL_LONGLIVE_PRIVATE_KEY_PATH', default: './src/certs-longlive/key.pem', name: 'Longlive Private Key' },
            { env: 'SSL_LONGLIVE_CERTIFICATE_PATH', default: './src/certs-longlive/cert.pem', name: 'Longlive Certificate' }
        ];

        longlivePaths.forEach(cert => {
            const certPath = process.env[cert.env] || cert.default;
            if (fs.existsSync(certPath)) {
                this.addResult(true, `${cert.name} found: ${certPath}`, 'info');
            } else {
                this.addResult(true, `${cert.name} not found (optional): ${certPath}`, 'warning');
            }
        });
    }

    /**
     * Validate database configuration
     */
    private validateDatabase(): void {
        const dbPath = process.env.SQLITE_DB_PATH || './cf2rtc-sqlite-db.db';
        const dbDir = path.dirname(dbPath);

        // Check if directory exists and is writable
        try {
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }
            // Test write permissions
            fs.accessSync(dbDir, fs.constants.W_OK);
            this.addResult(true, `Database directory writable: ${dbDir}`, 'info');
        } catch (error) {
            this.addResult(false, `Database directory not writable: ${dbDir}`);
        }

        // Check table names
        const mobileTable = process.env.MOBILE_TABLE_NAME || 'rtc_mobiles';
        const homenetTable = process.env.HOMENET_TABLE_NAME || 'rtc_homenet';
        
        if (mobileTable === homenetTable) {
            this.addResult(false, 'Mobile and homenet table names cannot be the same');
        } else {
            this.addResult(true, `Table names: mobile=${mobileTable}, homenet=${homenetTable}`, 'info');
        }
    }

    /**
     * Validate Firebase configuration
     */
    private validateFirebase(): void {
        const firebasePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './src/config/firebase-admin.json';
        
        if (fs.existsSync(firebasePath)) {
            try {
                const firebaseConfig = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
                const requiredFields = ['project_id', 'private_key', 'client_email'];
                const missingFields = requiredFields.filter(field => !firebaseConfig[field]);
                
                if (missingFields.length > 0) {
                    this.addResult(false, `Firebase config missing fields: ${missingFields.join(', ')}`);
                } else {
                    this.addResult(true, `Firebase configuration valid: ${firebasePath}`, 'info');
                }
            } catch (error) {
                this.addResult(false, `Invalid Firebase configuration JSON: ${firebasePath}`);
            }
        } else {
            this.addResult(false, `Firebase service account file not found: ${firebasePath}`);
        }
    }

    /**
     * Validate environment file
     */
    private validateEnvFile(): void {
        if (fs.existsSync('.env')) {
            this.addResult(true, '.env file found', 'info');
        } else if (fs.existsSync('.env.example')) {
            this.addResult(true, 'Create .env from .env.example template', 'warning');
        } else {
            this.addResult(false, 'No .env or .env.example file found');
        }
    }

    /**
     * Run all validations
     */
    public validate(): boolean {
        console.log('🔍 Validating CallFusion Environment Configuration...\n');

        this.validateEnvFile();
        this.validatePort();
        this.validateCertificates();
        this.validateDatabase();
        this.validateFirebase();

        // Display results
        let hasErrors = false;
        let hasWarnings = false;

        this.results.forEach(result => {
            const icon = result.severity === 'error' ? '❌' : 
                        result.severity === 'warning' ? '⚠️' : '✅';
            
            console.log(`${icon} ${result.message}`);
            
            if (!result.valid && result.severity === 'error') {
                hasErrors = true;
            }
            if (result.severity === 'warning') {
                hasWarnings = true;
            }
        });

        console.log('\n📊 Validation Summary:');
        console.log(`- Total checks: ${this.results.length}`);
        console.log(`- Errors: ${this.results.filter(r => !r.valid && r.severity === 'error').length}`);
        console.log(`- Warnings: ${this.results.filter(r => r.severity === 'warning').length}`);
        console.log(`- Info: ${this.results.filter(r => r.severity === 'info').length}`);

        if (hasErrors) {
            console.log('\n🚫 Environment validation failed! Please fix the errors above before starting the server.');
            return false;
        } else if (hasWarnings) {
            console.log('\n⚠️  Environment validation passed with warnings. Consider addressing the warnings above.');
            return true;
        } else {
            console.log('\n✅ Environment validation passed! Ready to start the server.');
            return true;
        }
    }
}

// Run validation if script is executed directly
const validator = new EnvironmentValidator();
const isValid = validator.validate();
process.exit(isValid ? 0 : 1);