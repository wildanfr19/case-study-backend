const { v4: uuidv4 } = require('uuid');
const dbManager = require('../config/database');

class DocumentService {
  async storeDocument(type, filePath, originalName) {
    const id = uuidv4();
    const db = dbManager.getConnection();
    await db.execute(
      'INSERT INTO documents (id, type, path, original_name) VALUES (?,?,?,?)',
      [id, type, filePath, originalName]
    );
    return { id, type, path: filePath, original_name: originalName };
  }

  async getDocument(id) {
    const db = dbManager.getConnection();
    const [rows] = await db.execute('SELECT * FROM documents WHERE id = ?', [id]);
    return rows[0] || null;
  }
}

module.exports = new DocumentService();
