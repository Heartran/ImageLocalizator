const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione CORS
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configurazione multer per il salvataggio dei file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|webp/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);

        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Solo immagini sono consentite (jpeg, jpg, png, webp)'));
        }
    }
});

// Endpoint per il caricamento dell'immagine
app.post('/api/upload-image', upload.single('image'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nessun file caricato' });
        }
        
        const imageUrl = `${req.protocol}://${req.get('host')}/${req.file.path.replace(/\\/g, '/')}`;
        
        res.json({
            success: true,
            message: 'Immagine caricata con successo',
            imageUrl: imageUrl,
            filename: req.file.filename
        });
    } catch (error) {
        console.error('Errore durante il caricamento:', error);
        res.status(500).json({ error: 'Errore durante il caricamento del file' });
    }
});

// Endpoint per il salvataggio delle coordinate
app.post('/api/save-coordinates', (req, res) => {
    try {
        const { imageName, points } = req.body;
        
        if (!imageName || !points || !Array.isArray(points)) {
            return res.status(400).json({ error: 'Dati non validi' });
        }
        
        const dataDir = 'data/';
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        const filename = `coordinates_${Date.now()}.json`;
        const filePath = path.join(dataDir, filename);
        
        const data = {
            imageName,
            points,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        res.json({
            success: true,
            message: 'Coordinate salvate con successo',
            filePath: filename
        });
    } catch (error) {
        console.error('Errore durante il salvataggio delle coordinate:', error);
        res.status(500).json({ error: 'Errore durante il salvataggio delle coordinate' });
    }
});

app.post('/api/log', (req, res) => {
    try {
        const { level = 'info', message = '', details = null } = req.body || {};
        const timestamp = new Date().toISOString();
        const prefix = `[client][${timestamp}][${String(level).toUpperCase()}]`;
        const logPayload = details !== null && typeof details !== 'undefined'
            ? util.inspect(details, { depth: 3, colors: false })
            : '';
        const output = `${prefix} ${message} ${logPayload}`.trim();
        const consoleLevel = ['error', 'warn', 'info'].includes(level) ? level : 'log';
        console[consoleLevel](output);
        res.json({ success: true });
    } catch (error) {
        console.error('Errore durante la registrazione del log client:', error);
        res.status(500).json({ success: false });
    }
});

// Avvia il server
app.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${PORT}`);
});
