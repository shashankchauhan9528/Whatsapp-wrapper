const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const router = express.Router();

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'whapi-user' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isClientReady = false;

// QR Code event - Scan this to login
client.on('qr', qr => {
    console.log('\n🔗 WhatsApp QR Code Generated!');
    console.log('📱 Scan this QR code with your WhatsApp app:\n');
    qrcode.generate(qr, { small: true });
    console.log('\nWaiting for authentication...\n');
});

// Client ready event
client.on('ready', () => {
    console.log('✅ WhatsApp Client is ready!');
    console.log('🟢 You can now send and receive messages\n');
    isClientReady = true;
});

// Authentication successful
client.on('authenticated', () => {
    console.log('🔐 Authentication successful!');
});

// Authentication failure
client.on('auth_failure', msg => {
    console.error('❌ Authentication failed:', msg);
});

// Disconnected event
client.on('disconnected', (reason) => {
    console.log('🔴 WhatsApp Client disconnected:', reason);
    isClientReady = false;
});



// Event for messages created (sent by logged-in account from any device)
client.on('message_create', async message => {
    const contact = await message.getContact();
    const chat = await message.getChat();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(message.fromMe ? '📤 MESSAGE SENT BY YOU' : '📥 MESSAGE RECEIVED');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`👤 ${message.fromMe ? 'To' : 'From'}: ${message.fromMe ? message.to : message.from}`);
    console.log(`📱 Contact: ${contact.pushname || contact.name || 'Unknown'}`);
    console.log(`💬 Message: ${message.body}`);
    console.log(`🕐 Time: ${new Date().toLocaleString()}`);
    console.log(`📄 Type: ${message.type}`);
    console.log(`💼 Chat: ${chat.name || 'Private Chat'}`);
    console.log(`📍 Is Group: ${chat.isGroup ? 'Yes' : 'No'}`);
    console.log(`🔵 Sent from: ${message.deviceType || 'Other Device'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});


// Initialize the client
console.log('🚀 Initializing WhatsApp Client...\n');
client.initialize();

// Routes

// GET /api/whatsapp/status - Check if client is ready
router.get('/status', (req, res) => {
    res.json({
        success: true,
        ready: isClientReady,
        message: isClientReady ? 'WhatsApp is connected' : 'WhatsApp is not ready yet'
    });
});

// POST /api/whatsapp/send - Send a message
router.post('/send', async (req, res) => {
    const { number, message } = req.body;

    // Validation
    if (!number || !message) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: number and message'
        });
    }

    // Check if client is ready
    if (!isClientReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp client is not ready. Please scan QR code first.'
        });
    }

    try {
        // Format the number correctly
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        
        // Send message
        await client.sendMessage(chatId, message);
        
        console.log(`\n📤 Message sent to ${number}`);
        console.log(`💬 Content: ${message}\n`);
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            to: number
        });
    } catch (err) {
        console.error('❌ Error sending message:', err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// GET /api/whatsapp/qr - Get QR code status
router.get('/qr', (req, res) => {
    res.json({
        success: true,
        message: isClientReady 
            ? 'Already authenticated' 
            : 'Check your terminal for QR code'
    });
});

module.exports = router;