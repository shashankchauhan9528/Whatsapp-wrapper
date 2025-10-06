const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // add this at top
require('dotenv').config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// WhatsApp Client
let client;
let isClientReady = false;
let qrCodeData = null;

// Middleware
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// API Key middleware
const authenticateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
};

// File upload configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Initialize WhatsApp Client
function initializeWhatsAppClient() {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    // QR Code event
    client.on('qr', (qr) => {
        console.log('QR Code received. Please scan with your phone:');
        qrcode.generate(qr, { small: true });
        qrCodeData = qr;
    });

    // Ready event
    client.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        isClientReady = true;
        qrCodeData = null;
    });

    // Authentication events
    client.on('authenticated', () => {
        console.log('Client authenticated successfully');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        isClientReady = false;
    });

    client.on('disconnected', (reason) => {
        console.log('Client disconnected:', reason);
        isClientReady = false;
        qrCodeData = null;
    });

    // Message event for auto-replies
    client.on('message', async (message) => {
console.log('Message received from:', JSON.stringify(message, null, 2));


        console.log(`Message received from ${message.from}: ${message.body}`);
 // ✅ Forward the message to your webhook dynamically
    if (process.env.WebhookUrl) {
      await axios.post(process.env.WebhookUrl, {
        from: message.from,
        body: message.body,
        timestamp: message.timestamp,
        id: message.id._serialized,
        type: message.type,
        hasMedia: message.hasMedia || false
      });
      console.log('✅ Message forwarded to webhook');
    } else {
      console.warn('⚠️ Webhook URL not set in .env');
    }
        // Auto-reply logic
        if (message.body.toLowerCase() === '!ping') {
            await message.reply('🏓 Pong! Bot is active');
        }
        
        if (message.body.toLowerCase() === '!help') {
            await message.reply(`🤖 *WhatsApp Bot Commands:*
            
!ping - Test bot response
!help - Show this help message
!time - Get current time
!info - Get your contact info`);
        }
        
        if (message.body.toLowerCase() === '!time') {
            await message.reply(`🕐 Current time: ${new Date().toLocaleString()}`);
        }
        
        if (message.body.toLowerCase() === '!info') {
            const contact = await message.getContact();
            await message.reply(`👤 *Your Info:*
Name: ${contact.name || 'Not saved'}
Number: ${contact.number}
Chat Type: ${message.from.includes('@g.us') ? 'Group' : 'Individual'}`);
        }
    });

    // Initialize client
    client.initialize();
}

// API Routes

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        clientReady: isClientReady
    });
});
// Route to serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Get QR Code
app.get('/api/qr', authenticateApiKey, (req, res) => {
    if (isClientReady) {
        return res.json({ message: 'Client is already authenticated' });
    }
    
    if (!qrCodeData) {
        return res.json({ message: 'QR code not available yet. Please wait...' });
    }
    
    res.json({ qr: qrCodeData });
});

// Get client status
app.get('/api/status', authenticateApiKey, (req, res) => {
    res.json({
        ready: isClientReady,
        hasQR: !!qrCodeData,
        timestamp: new Date().toISOString()
    });
});

// Send text message
app.post('/api/send-message', authenticateApiKey, async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const { to, message, delay = 0 } = req.body;

        if (!to || !message) {
            return res.status(400).json({ error: 'Missing required fields: to, message' });
        }

        // Add delay if specified
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Format phone number
        const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
        
        const chat = await client.getChatById(chatId);
        const sentMessage = await chat.sendMessage(message);

        res.json({
            success: true,
            messageId: sentMessage.id._serialized,
            to: chatId,
            message: message,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send bulk messages
app.post('/api/send-bulk', authenticateApiKey, async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const { recipients, message, delay = 2000 } = req.body;

        if (!recipients || !Array.isArray(recipients) || !message) {
            return res.status(400).json({ error: 'Missing required fields: recipients (array), message' });
        }

        const results = [];

        for (const recipient of recipients) {
            try {
                const chatId = recipient.includes('@c.us') ? recipient : `${recipient}@c.us`;
                const chat = await client.getChatById(chatId);
                const sentMessage = await chat.sendMessage(message);
                
                results.push({
                    to: chatId,
                    success: true,
                    messageId: sentMessage.id._serialized
                });

                // Add delay between messages
                if (delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

            } catch (error) {
                results.push({
                    to: recipient,
                    success: false,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            results: results,
            total: recipients.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });

    } catch (error) {
        console.error('Error sending bulk messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send media message
app.post('/api/send-media', authenticateApiKey, upload.single('media'), async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const { to, caption = '' } = req.body;
        const mediaFile = req.file;

        if (!to || !mediaFile) {
            return res.status(400).json({ error: 'Missing required fields: to, media file' });
        }

        const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
        const media = MessageMedia.fromFilePath(mediaFile.path);
        
        const chat = await client.getChatById(chatId);
        const sentMessage = await chat.sendMessage(media, { caption: caption });

        // Clean up uploaded file
        fs.unlinkSync(mediaFile.path);

        res.json({
            success: true,
            messageId: sentMessage.id._serialized,
            to: chatId,
            caption: caption,
            mediaType: mediaFile.mimetype,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error sending media:', error);
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message });
    }
});

// Get chats
app.get('/api/chats', authenticateApiKey, async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const chats = await client.getChats();
        const chatList = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            isReadOnly: chat.isReadOnly,
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp
        }));

        res.json({
            success: true,
            chats: chatList,
            total: chatList.length
        });

    } catch (error) {
        console.error('Error getting chats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get contact info
app.get('/api/contact/:phoneNumber', authenticateApiKey, async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const { phoneNumber } = req.params;
        const contactId = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
        
        const contact = await client.getContactById(contactId);

        res.json({
            success: true,
            contact: {
                id: contact.id._serialized,
                name: contact.name,
                number: contact.number,
                isMyContact: contact.isMyContact,
                isBusiness: contact.isBusiness,
                profilePicUrl: await contact.getProfilePicUrl().catch(() => null)
            }
        });

    } catch (error) {
        console.error('Error getting contact:', error);
        res.status(500).json({ error: error.message });
    }
});

// Restart client
app.post('/api/restart', authenticateApiKey, async (req, res) => {
    try {
        if (client) {
            await client.destroy();
        }
        
        isClientReady = false;
        qrCodeData = null;
        
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 2000);

        res.json({
            success: true,
            message: 'Client restart initiated'
        });

    } catch (error) {
        console.error('Error restarting client:', error);
        res.status(500).json({ error: error.message });
    }
});


// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📱 API Documentation available at http://localhost:${PORT}/health`);
    
    // Initialize WhatsApp client
    initializeWhatsAppClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});
