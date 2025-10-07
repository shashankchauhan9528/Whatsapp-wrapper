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
const express = require('express');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // Add this for QR generation
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// WhatsApp Client
let client;
let isClientReady = false;
let qrCodeData = null;
let store = null;

// Email configuration - Fixed with proper Gmail setup
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Function to send QR code via email
async function sendQRCodeEmail(qrCode) {
    try {
        if (!process.env.EMAIL_USER || !process.env.NOTIFICATION_EMAIL) {
            console.warn('⚠️ Email configuration missing. Cannot send QR code.');
            return;
        }

        // Generate QR code as base64 image
        const qrCodeImage = await QRCode.toDataURL(qrCode, {
            type: 'image/png',
            quality: 0.92,
            margin: 1,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.NOTIFICATION_EMAIL,
            subject: '📱 WhatsApp Bot QR Code - Scan to Login',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; text-align: center;">
                    <h2 style="color: #25D366;">📱 WhatsApp Bot QR Code</h2>
                    <div style="background-color: #f5f5f5; padding: 30px; border-radius: 10px; margin: 20px 0;">
                        <p style="font-size: 18px; color: #333; margin-bottom: 20px;">
                            <strong>Scan this QR code with your WhatsApp mobile app to connect:</strong>
                        </p>
                        <div style="background-color: white; padding: 20px; border-radius: 10px; display: inline-block;">
                            <img src="${qrCodeImage}" alt="WhatsApp QR Code" style="max-width: 300px; height: auto;" />
                        </div>
                    </div>
                    <div style="margin-top: 30px; padding: 20px; background-color: #e8f5e8; border-radius: 5px;">
                        <h3 style="color: #1976d2;">📋 Instructions:</h3>
                        <ol style="text-align: left; color: #333; line-height: 1.6;">
                            <li>Open WhatsApp on your phone</li>
                            <li>Tap <strong>Menu</strong> (three dots) → <strong>Linked devices</strong></li>
                            <li>Tap <strong>Link a device</strong></li>
                            <li>Point your phone at this QR code</li>
                            <li>Wait for connection confirmation</li>
                        </ol>
                    </div>
                    <div style="margin-top: 20px; padding: 15px; background-color: #fff3cd; border-radius: 5px;">
                        <p style="color: #856404; margin: 0;">
                            ⏰ <strong>Note:</strong> This QR code will expire in a few minutes. 
                            If it doesn't work, restart your bot to generate a new one.
                        </p>
                    </div>
                    <hr style="margin: 30px 0;">
                    <p style="color: #666; font-size: 12px;">
                        Generated at: ${new Date().toLocaleString()}<br>
                        Server: ${process.env.RENDER_EXTERNAL_URL || 'Local Development'}
                    </p>
                </div>
            `,
            attachments: [{
                filename: 'whatsapp-qr.png',
                content: qrCodeImage.split('base64,')[1],
                encoding: 'base64',
                cid: 'qrcode'
            }]
        };

        await emailTransporter.sendMail(mailOptions);
        console.log('📧 QR Code sent to email successfully');
    } catch (error) {
        console.error('❌ Failed to send QR code email:', error.message);
    }
}

// Function to send logout notification
async function sendLogoutNotification(reason) {
    try {
        if (!process.env.EMAIL_USER || !process.env.NOTIFICATION_EMAIL) {
            console.warn('⚠️ Email configuration missing. Cannot send logout notification.');
            return;
        }

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.NOTIFICATION_EMAIL,
            subject: '🚨 WhatsApp Bot Disconnected - Alert',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #d32f2f;">🚨 WhatsApp Bot Disconnection Alert</h2>
                    <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px;">
                        <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                        <p><strong>Reason:</strong> ${reason || 'Unknown'}</p>
                        <p><strong>Server:</strong> ${process.env.RENDER_EXTERNAL_URL || 'Local'}</p>
                    </div>
                    <div style="margin-top: 20px;">
                        <h3 style="color: #1976d2;">Recommended Actions:</h3>
                        <ul>
                            <li>Check server logs for detailed error information</li>
                            <li>Verify internet connectivity</li>
                            <li>Restart the WhatsApp client if necessary</li>
                            <li>Re-scan QR code if authentication is required</li>
                        </ul>
                    </div>
                    <div style="margin-top: 20px; padding: 15px; background-color: #e3f2fd; border-radius: 5px;">
                        <p style="color: #1565c0; margin: 0;">
                            💡 <strong>Tip:</strong> The bot will automatically attempt to reconnect in 30 seconds. 
                            You'll receive a new QR code via email if needed.
                        </p>
                    </div>
                    <hr style="margin: 30px 0;">
                    <p style="color: #666; font-size: 12px;">
                        This is an automated notification from your WhatsApp Bot service.
                    </p>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
        console.log('📧 Logout notification email sent successfully');
    } catch (error) {
        console.error('❌ Failed to send logout notification email:', error.message);
    }
}

// Function to send ready notification
async function sendReadyNotification() {
    try {
        if (!process.env.EMAIL_USER || !process.env.NOTIFICATION_EMAIL) return;

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.NOTIFICATION_EMAIL,
            subject: '✅ WhatsApp Bot Connected Successfully',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4caf50;">✅ WhatsApp Bot Connected</h2>
                    <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px;">
                        <p><strong>Status:</strong> Successfully Connected & Ready</p>
                        <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                        <p><strong>Server:</strong> ${process.env.RENDER_EXTERNAL_URL || 'Local'}</p>
                    </div>
                    <p style="color: #666; margin-top: 20px;">
                        🎉 Your WhatsApp bot is now ready to receive and send messages!
                    </p>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
        console.log('📧 Ready notification email sent successfully');
    } catch (error) {
        console.error('❌ Failed to send ready notification email:', error.message);
    }
}

// Test email configuration on startup
async function testEmailConfiguration() {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
            console.warn('⚠️ Email credentials not configured in .env file');
            console.warn('⚠️ Please check EMAIL_USER and EMAIL_PASSWORD variables');
            return;
        }

        console.log('🔍 Testing email configuration...');
        await emailTransporter.verify();
        console.log('✅ Email configuration verified successfully');
    } catch (error) {
        console.error('❌ Email configuration test failed:', error.message);
        console.error('❌ Please check your Gmail App Password and 2FA settings');
    }
}

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

// Keep-alive mechanism
const keepAlive = () => {
    setInterval(() => {
        console.log('🔄 Keep-alive ping:', new Date().toISOString());
    }, 14 * 60 * 1000);
};

// Self-ping to prevent sleep
if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(async () => {
        try {
            await axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`);
            console.log('🏓 Self-ping successful');
        } catch (error) {
            console.error('❌ Self-ping failed:', error.message);
        }
    }, 14 * 60 * 1000);
}

// Initialize MongoDB connection and WhatsApp Client
async function initializeWhatsAppClient() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('🗄️ Connected to MongoDB successfully');

        // Initialize MongoDB Store
        store = new MongoStore({ mongoose: mongoose });

        client = new Client({
            authStrategy: new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000,
                clientId: process.env.CLIENT_ID || 'whatsapp-bot'
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
                    '--disable-gpu',
                    '--disable-extensions'
                ]
            }
        });

        // QR Code event - Now sends via email
        client.on('qr', async (qr) => {
            console.log('📱 QR Code received. Sending via email...');
            qrcode.generate(qr, { small: true });
            qrCodeData = qr;
            
            // Send QR code via email
            await sendQRCodeEmail(qr);
        });

        // Ready event
        client.on('ready', async () => {
            console.log('✅ WhatsApp Client is ready!');
            isClientReady = true;
            qrCodeData = null;
            await sendReadyNotification();
        });

        // Authentication events
        client.on('authenticated', () => {
            console.log('🔐 Client authenticated successfully');
        });

        client.on('auth_failure', async (msg) => {
            console.error('❌ Authentication failed:', msg);
            isClientReady = false;
            await sendLogoutNotification(`Authentication failure: ${msg}`);
        });

        // Enhanced disconnection handling
        client.on('disconnected', async (reason) => {
            console.log('🔌 Client disconnected:', reason);
            isClientReady = false;
            qrCodeData = null;
            
            await sendLogoutNotification(reason);
            
            // Auto-reconnect after 30 seconds
            setTimeout(() => {
                console.log('🔄 Attempting to reconnect...');
                initializeWhatsAppClient();
            }, 30000);
        });

        // Remote session events
        client.on('remote_session_saved', () => {
            console.log('💾 Session saved to MongoDB');
        });

        // Message event
        client.on('message', async (message) => {
            console.log(`📨 Message received from ${message.from}: ${message.body}`);

            // Forward to webhook
            if (process.env.WebhookUrl) {
                try {
                    await axios.post(process.env.WebhookUrl, {
                        from: message.from,
                        body: message.body,
                        timestamp: message.timestamp,
                        id: message.id._serialized,
                        type: message.type,
                        hasMedia: message.hasMedia || false
                    });
                    console.log('✅ Message forwarded to webhook');
                } catch (error) {
                    console.error('❌ Failed to forward message to webhook:', error.message);
                }
            }

            // Auto-reply logic
            if (message.body.toLowerCase() === '!ping') {
                await message.reply('🏓 Pong! Bot is active with MongoDB & Email notifications!');
            }
            
            if (message.body.toLowerCase() === '!help') {
                await message.reply(`🤖 *WhatsApp Bot Commands:*
                
!ping - Test bot response
!help - Show this help message
!time - Get current time
!info - Get your contact info
!status - Get bot status`);
            }
            
            if (message.body.toLowerCase() === '!time') {
                await message.reply(`🕐 Current time: ${new Date().toLocaleString()}`);
            }
            
            if (message.body.toLowerCase() === '!status') {
                await message.reply(`📊 *Bot Status:*
Ready: ${isClientReady ? '✅' : '❌'}
Database: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}
Uptime: ${Math.floor(process.uptime() / 60)} minutes
Email: ${process.env.EMAIL_USER ? '✅ Configured' : '❌ Not configured'}`);
            }
            
            if (message.body.toLowerCase() === '!info') {
                const contact = await message.getContact();
                await message.reply(`👤 *Your Info:*
Name: ${contact.name || 'Not saved'}
Number: ${contact.number}
Chat Type: ${message.from.includes('@g.us') ? 'Group' : 'Individual'}`);
            }
        });

        await client.initialize();

    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp client:', error);
        await sendLogoutNotification(`Initialization error: ${error.message}`);
        
        setTimeout(() => {
            console.log('🔄 Retrying initialization...');
            initializeWhatsAppClient();
        }, 60000);
    }
}

// API Routes

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        clientReady: isClientReady,
        mongoStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        emailConfigured: !!(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD)
    });
});

// Get QR Code via email
app.get('/api/qr-email', authenticateApiKey, async (req, res) => {
    try {
        if (isClientReady) {
            return res.json({ message: 'Client is already authenticated' });
        }
        
        if (!qrCodeData) {
            return res.json({ message: 'QR code not available yet. Please wait...' });
        }
        
        await sendQRCodeEmail(qrCodeData);
        res.json({ 
            message: 'QR code sent to email successfully',
            email: process.env.NOTIFICATION_EMAIL 
        });
        
    } catch (error) {
        console.error('Error sending QR email:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get QR Code (original endpoint)
app.get('/api/qr', authenticateApiKey, (req, res) => {
    if (isClientReady) {
        return res.json({ message: 'Client is already authenticated' });
    }
    
    if (!qrCodeData) {
        return res.json({ message: 'QR code not available yet. Please wait...' });
    }
    
    res.json({ qr: qrCodeData });
});

// Test email endpoint
app.post('/api/test-email', authenticateApiKey, async (req, res) => {
    try {
        await testEmailConfiguration();
        
        const testMailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.NOTIFICATION_EMAIL,
            subject: '✅ Email Test - WhatsApp Bot',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4caf50;">✅ Email Configuration Test</h2>
                    <p>This is a test email from your WhatsApp Bot.</p>
                    <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                    <p>If you received this email, your configuration is working correctly!</p>
                </div>
            `
        };
        
        await emailTransporter.sendMail(testMailOptions);
        
        res.json({
            success: true,
            message: 'Test email sent successfully',
            sentTo: process.env.NOTIFICATION_EMAIL
        });
        
    } catch (error) {
        console.error('Email test failed:', error);
        res.status(500).json({ 
            error: 'Email test failed', 
            details: error.message 
        });
    }
});

// ... [Include all your other existing API routes - they remain unchanged] ...

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/health`);
    
    await testEmailConfiguration();
    keepAlive();
    initializeWhatsAppClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (client) await client.destroy();
    if (mongoose.connection.readyState === 1) await mongoose.connection.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    if (client) await client.destroy();
    if (mongoose.connection.readyState === 1) await mongoose.connection.close();
    process.exit(0);
});
