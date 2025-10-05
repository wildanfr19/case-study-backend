const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

class PDFService {
    // Unified, correctly cased method name
    async extractTextFromPDF(filePath) {
        try {
            if (!filePath) throw new Error('File path is empty');
            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) {
                throw new Error(`File not found: ${resolved}`);
            }
            const dataBuffer = fs.readFileSync(resolved);
            const data = await pdfParse(dataBuffer);
            return {
                text: data.text || '',
                pages: data.numpages || 0,
                info: data.info || {}
            };
        } catch (error) {
            console.error('Error extracting PDF:', error.message);
            throw new Error('Failed to extract text from PDF');
        }
    }

    cleanText(text) {
        return text
            .replace(/\s+/g, ' ') 
            .replace(/\n+/g, '\n') 
            .trim();
    }

    async processPDF(filePath) {
        const extracted = await this.extractTextFromPDF(filePath);
        const cleanedText = this.cleanText(extracted.text || '');

        return {
            text: cleanedText,
            pages: extracted.pages,
            wordCount: cleanedText ? cleanedText.split(/\s+/).filter(Boolean).length : 0,
            preview: cleanedText.substring(0, 200)
        };
    }
}
module.exports = new PDFService();