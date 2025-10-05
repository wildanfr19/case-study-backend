const mysql = require('mysql2/promise');


class DatabaseManager {
    constructor() {
        this.connection = null;
    }

    async init() {
        try {
            this.connection = await mysql.createConnection({
                host: process.env.DB_HOST || 'localhost',
                port: process.env.DB_PORT || 3306,
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'case_study_backend'
            });
            
            console.log('MySQL connected successfully');
            await this.createTables();
            return this.connection;
        } catch (error) {
            console.error('MySQL connection error:', error);
            throw error;
        }
    }

    async createTables() {
        const statements = [
            `CREATE TABLE IF NOT EXISTS documents (
                id VARCHAR(36) PRIMARY KEY,
                type ENUM('cv','project','job_description','case_brief','rubric_cv','rubric_project') NOT NULL,
                path VARCHAR(255) NOT NULL,
                original_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS evaluations (
                id VARCHAR(36) PRIMARY KEY,
                status ENUM('queued', 'processing', 'completed', 'failed','canceled') DEFAULT 'queued',
                job_title VARCHAR(255),
                cv_document_id VARCHAR(36),
                project_document_id VARCHAR(36),
                cv_file_path VARCHAR(255),
                project_file_path VARCHAR(255),
                result JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_status (status),
                INDEX idx_created (created_at),
                FOREIGN KEY (cv_document_id) REFERENCES documents(id) ON DELETE SET NULL,
                FOREIGN KEY (project_document_id) REFERENCES documents(id) ON DELETE SET NULL
            )`
        ];
        try {
            for (const stmt of statements) {
                await this.connection.execute(stmt);
            }
            // Add missing columns defensively (in case table existed from older version)
            const addCols = [
                "ALTER TABLE evaluations ADD COLUMN job_title VARCHAR(255) NULL",
                "ALTER TABLE evaluations ADD COLUMN cv_document_id VARCHAR(36) NULL",
                "ALTER TABLE evaluations ADD COLUMN project_document_id VARCHAR(36) NULL"
            ];
            for (const alter of addCols) {
                try { await this.connection.execute(alter); } catch { /* ignore if exists */ }
            }
            console.log('Tables ensured successfully');
        } catch (error) {
            console.error('Error ensuring tables:', error);
            throw error;
        }
    }

    getConnection() {
        if (!this.connection) {
            throw new Error('Database not connected. Call init() first.');
        }
        return this.connection;
    }

    async close() {
        if (this.connection) {
            await this.connection.end();
            console.log('MySQL connection closed');
        }
    }
}

module.exports = new DatabaseManager();
