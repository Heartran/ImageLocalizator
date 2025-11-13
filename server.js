const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const util = require('util');

const fsPromises = fs.promises;
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
let fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

const app = express();
const PORT = process.env.PORT || 3000;

async function fetchWithPolyfill(url, options) {
    if (!fetchImpl) {
        const module = await import('node-fetch');
        fetchImpl = module.default;
    }
    return fetchImpl(url, options);
}

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

app.get('/api/ollama/models', async (req, res) => {
    try {
        const response = await fetchWithPolyfill(`${OLLAMA_URL}/api/tags`);
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Status ${response.status}: ${detail.slice(0, 400)}`);
        }
        const payload = await response.json();
        const models = Array.isArray(payload.models)
            ? payload.models.map((model) => ({
                name: model.name,
                modified: model.modified_at,
                size: model.size,
                parameterSize: model.details?.parameter_size ?? null,
                quantization: model.details?.quantization_level ?? null,
                family: model.details?.family ?? model.model ?? null
            }))
            : [];
        res.json({ success: true, models });
    } catch (error) {
        console.error('Errore nel recupero dei modelli Ollama:', error);
        res.status(502).json({
            success: false,
            error: 'Impossibile recuperare i modelli disponibili da Ollama',
            details: error.message
        });
    }
});

app.post('/api/ollama/autolocate', async (req, res) => {
    try {
        const { model, filename, existingPoints = [] } = req.body || {};
        if (!model) {
            return res.status(400).json({ success: false, error: 'Specificare il modello Ollama da utilizzare.' });
        }
        if (!filename) {
            return res.status(400).json({ success: false, error: 'Nessuna immagine associata alla richiesta.' });
        }
        const safeFilename = path.basename(filename);
        const absolutePath = path.join(__dirname, 'uploads', safeFilename);
        if (!fs.existsSync(absolutePath)) {
            return res.status(404).json({ success: false, error: 'Immagine non trovata sul server.' });
        }
        const buffer = await fsPromises.readFile(absolutePath);
        const prompt = buildAutoLocatePrompt(existingPoints);
        const response = await fetchWithPolyfill(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt,
                images: [buffer.toString('base64')],
                stream: false,
                options: {
                    temperature: 0.15
                }
            })
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Richiesta a Ollama fallita (${response.status}): ${detail.slice(0, 400)}`);
        }
        const payload = await response.json();
        const rawText = (payload.response || '').trim();
        const parsed = extractJsonFromText(rawText);
        res.json({
            success: true,
            suggestions: Array.isArray(parsed?.mapPoints) ? parsed.mapPoints : [],
            pose: parsed?.estimatedPose || null,
            analysis: parsed?.analysis || parsed?.reasoning || rawText,
            raw: rawText
        });
    } catch (error) {
        console.error('Errore durante la localizzazione via Ollama:', error);
        res.status(502).json({
            success: false,
            error: 'Impossibile completare la localizzazione tramite Ollama',
            details: error.message
        });
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

function buildAutoLocatePrompt(existingPoints = []) {
    const intro = [
        'Sei un assistente di geolocalizzazione che analizza immagini urbane e deve proporre corrispondenze su OpenStreetMap.',
        'Per ogni punto importante individua latitudine, longitudine e un\'altitudine stimata (in metri).',
        'Utilizza i punti immagine già noti (coordinate normalizzate 0-1) per capire dove posizionare i marker.',
        'Rispondi SOLO con JSON valido.'
    ].join(' ');
    const formattedPoints = formatExistingPoints(existingPoints);
    const schema = [
        '{',
        '  "mapPoints": [',
        '    {',
        '      "description": "breve testo",',
        '      "confidence": 0.0-1.0,',
        '      "imagePoint": { "xNorm": numero, "yNorm": numero },',
        '      "mapPoint": { "lat": numero, "lng": numero, "altitude": numero opzionale }',
        '    }',
        '  ],',
        '  "estimatedPose": { "lat": numero, "lng": numero, "altitude": numero, "heading": numero, "tilt": numero },',
        '  "analysis": "massimo due frasi che riassumono il ragionamento"',
        '}'
    ].join('\n');
    return `${intro}\n${formattedPoints}\nFornisci almeno tre punti se possibile e compila sempre i campi numerici.\n${schema}`;
}

function formatExistingPoints(points = []) {
    if (!Array.isArray(points) || points.length === 0) {
        return 'Nessun punto immagine precedente: proponi tu i landmark più distintivi.';
    }
    const lines = points.slice(0, 12).map((point, index) => {
        const label = sanitizePromptText(point.label || `P${point.id ?? index + 1}`);
        const xNorm = Number.isFinite(point.xNorm) ? point.xNorm : Number(point.normalizedX);
        const yNorm = Number.isFinite(point.yNorm) ? point.yNorm : Number(point.normalizedY);
        const coords = [
            Number.isFinite(xNorm) ? `xNorm=${xNorm.toFixed(4)}` : null,
            Number.isFinite(yNorm) ? `yNorm=${yNorm.toFixed(4)}` : null
        ].filter(Boolean).join(', ');
        const note = point.description ? `, descrizione: ${sanitizePromptText(point.description)}` : '';
        return `- ${label}${coords ? ` (${coords})` : ''}${note}`;
    });
    return `Punti immagine già annotati:\n${lines.join('\n')}`;
}

function sanitizePromptText(value) {
    return String(value ?? '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

function extractJsonFromText(text) {
    if (!text) {
        return null;
    }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
        return null;
    }
    const candidate = text.slice(first, last + 1);
    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

// Avvia il server
app.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${PORT}`);
});
