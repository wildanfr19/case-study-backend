const multer = require('multer');
const path = require('path');
const fs = require('fs');


const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Konfigurasi storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate nama file unik: timestamp-originalname
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

// Filter file - hanya terima PDF
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Only PDF files are allowed!'), false);
    }
};

// Konfigurasi multer
const upload = multer({
    storage: storage,
    limits: {
        fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 // 10MB
    },
    fileFilter: fileFilter
});

// Middleware untuk upload CV dan Project Report
const uploadFiles = upload.fields([
    { name: 'cv', maxCount: 1 },
    { name: 'project_report', maxCount: 1 }
]);

// Error handling untuk multer
const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                error: 'File too large',
                message: 'File size must be less than 10MB'
            });
        }
    }
    
    if (err.message === 'Only PDF files are allowed!') {
        return res.status(400).json({
            error: 'Invalid file type',
            message: 'Only PDF files are allowed'
        });
    }
    
    next(err);
};

module.exports = {
    uploadFiles,
    handleUploadError
};