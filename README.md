# @Dutakey/WhatsMulti

> [!IMPORTANT]
> **This is the `v2` branch — a full rewrite in progress.**
> The documentation below describes the v1 API, which now lives under `legacy/` and
> is not built on this branch. See [`docs/REWRITE-v2-PLAN.md`](docs/REWRITE-v2-PLAN.md)
> for the plan, and [`spec/`](spec/) for the cross-runtime contract shared with the
> planned Go implementation.

![NPM Downloads](https://img.shields.io/npm/dw/%40dutakey%2Fwhatsmulti?label=npm&color=%23CB3837)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/dutakey/whatsmulti)

## 📌 Overview

@Dutakey/WhatsMulti is a powerful wrapper for [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys), designed to efficiently manage multiple WhatsApp Web sessions. It offers advanced session handling, flexible event listeners, and various storage options, making it ideal for developers integrating WhatsApp into their applications.

## 🚀 Installation

Install via npm:

```sh
npm install @dutakey/whatsmulti
```

Or using yarn:

```sh
yarn add @dutakey/whatsmulti
```

## ✨ Key Features

- **Seamless Multi-Session Management**: Effortlessly create, manage, and maintain multiple WhatsApp sessions.
- **Flexible Storage Options**: Store sessions locally, in memory, or integrate with databases like MongoDB.
- **Robust Event Handling**: Easily handle events across multiple sessions for real-time monitoring.
- **QR Code Generation**: Automatically generate QR codes for session authentication.
- **Message Sending**: Send various types of messages (text, images, etc.) across sessions.
- **Session Lifecycle Management**: Start, stop, restart, and delete sessions programmatically.

## 📋 Table of Contents

- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [API Reference](#-api-reference)
- [Session Management](#-session-management)
- [Event Handling](#-event-handling)
- [Message Operations](#-message-operations)
- [Storage Options](#-storage-options)
- [Examples](#-examples)
- [TypeScript Support](#-typescript-support)
- [Contributing](#-contributing)
- [License](#-license)

## 🚀 Quick Start

```typescript
import WhatsMulti from '@dutakey/whatsmulti';

const client = new WhatsMulti({
    mongoUri: 'mongodb://localhost:27017/whatsmulti-db', // Optional
    defaultConnectionType: 'local', // 'local' | 'mongodb' | 'memory'
});

// Create and start a session
await client.createSession('my-session', 'local', {
    printQR: true, // Print QR code to console
});

await client.startSession('my-session');

// Listen for events
client.on('open', (_, { sessionId }) => {
    console.log(`Session ${sessionId} is connected!`);
});

client.on('messages.upsert', async (data, { sessionId }) => {
    const message = data.messages[0];
    console.log('New message:', message);
});
```

## ⚙️ Configuration

### Constructor Options

```typescript
interface ConfigType {
    defaultConnectionType?: 'local' | 'mongodb' | 'memory';
    localConnectionPath?: string;
    LoggerLevel?: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    BaileysLoggerLevel?: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    mongoUri?: string;
}
```

### Socket Configuration

```typescript
interface SockConfig {
    disableQRRetry?: boolean;
    qrMaxWaitMs?: number;
    printQR?: boolean;
    // ... other Baileys SocketConfig options
}
```

## 📚 API Reference

### WhatsMulti Class

#### Constructor

```typescript
new WhatsMulti(config?: ConfigType)
```

#### Methods

##### Session Management

```typescript
// Create a new session
await createSession(
    id: string,
    connectionType: 'local' | 'mongodb' | 'memory' = 'local',
    socketConfig?: Partial<SockConfig>
): Promise<void>

// Start a session
await startSession(id: string): Promise<void>

// Stop a session
await stopSession(id: string): Promise<void>

// Restart a session
await restartSession(id: string): Promise<void>

// Delete a session
await deleteSession(id: string): Promise<void>

// Logout a session
await logoutSession(id: string): Promise<void>

// Get session information
await getSession(id: string): Promise<SessionInstance | undefined>

// Get all sessions
await getSessions(): Promise<SessionInstance[]>

// Get QR code for a session
await getQr(id: string): Promise<{ image: string; qr: string } | undefined>

// Load existing sessions
await loadSessions(): Promise<void>
```

##### Message Operations

```typescript
// Send a message
await sendMessage(
    sessionId: string,
    recipient: string | MessageType,
    message: MessageContentType,
    options?: MessageOptionsType
): Promise<void>
```

## 🔧 Session Management

### Creating Sessions

Sessions can be created with different storage types:

```typescript
// Local storage (files)
await client.createSession('session-1', 'local');

// MongoDB storage
await client.createSession('session-2', 'mongodb');

// Memory storage (temporary)
await client.createSession('session-3', 'memory');
```

### Session Lifecycle

```typescript
// Create and start
await client.createSession('my-session', 'local', {
    printQR: true,
    qrMaxWaitMs: 60000,
});
await client.startSession('my-session');

// Stop temporarily
await client.stopSession('my-session');

// Restart
await client.restartSession('my-session');

// Logout and clean up
await client.logoutSession('my-session');

// Completely remove
await client.deleteSession('my-session');
```

### Loading Existing Sessions

```typescript
// Load all previously created sessions
await client.loadSessions();
```

## 📡 Event Handling

WhatsMulti extends EventEmitter and provides all Baileys events plus custom events:

### Built-in Events

```typescript
// Connection events
client.on('open', (data, { sessionId, socket }) => {
    console.log(`Session ${sessionId} connected`);
});

client.on('close', (data, { sessionId }) => {
    console.log(`Session ${sessionId} disconnected`);
});

client.on('connecting', (data, { sessionId }) => {
    console.log(`Session ${sessionId} is connecting...`);
});

// QR Code event
client.on('qr', (data, { sessionId }) => {
    console.log(`QR Code for ${sessionId}:`, data.qr);
    // data.image contains base64 image data
});

// Message events
client.on('messages.upsert', (data, { sessionId, socket }) => {
    data.messages.forEach(message => {
        console.log(`New message in ${sessionId}:`, message);
    });
});

// Contact events
client.on('contacts.update', (contacts, { sessionId }) => {
    console.log(`Contacts updated in ${sessionId}:`, contacts);
});

// Group events
client.on('groups.update', (groups, { sessionId }) => {
    console.log(`Groups updated in ${sessionId}:`, groups);
});
```

### Event Processing

You can also use the `process` method to handle all events in one place:

```typescript
client.process((events, { sessionId, socket }) => {
    if (events['messages.upsert']) {
        // Handle messages
    }
    if (events.qr) {
        // Handle QR code
    }
    // Handle other events...
});
```

## 💬 Message Operations

### Sending Messages

```typescript
// Text message
await client.sendMessage('session-1', '1234567890@s.whatsapp.net', {
    text: 'Hello, World!'
});

// Reply to a message
await client.sendMessage('session-1', originalMessage, {
    text: 'This is a reply'
}, {
    quoted: originalMessage
});

// Image message
await client.sendMessage('session-1', '1234567890@s.whatsapp.net', {
    image: { url: 'https://example.com/image.jpg' },
    caption: 'Check out this image!'
});

// Document message
await client.sendMessage('session-1', '1234567890@s.whatsapp.net', {
    document: { url: 'https://example.com/document.pdf' },
    fileName: 'document.pdf',
    mimetype: 'application/pdf'
});
```

### Message Types

WhatsMulti supports all Baileys message types:
- Text messages
- Image messages
- Video messages
- Audio messages
- Document messages
- Sticker messages
- Location messages
- Contact messages
- And more...

## 💾 Storage Options

### Local Storage

Sessions are stored as files in the local filesystem:

```typescript
const client = new WhatsMulti({
    localConnectionPath: './sessions', // Default: './whatsmulti_sessions'
});

await client.createSession('my-session', 'local');
```

### MongoDB Storage

Sessions are stored in a MongoDB database:

```typescript
const client = new WhatsMulti({
    mongoUri: 'mongodb://localhost:27017/whatsmulti-db'
});

await client.createSession('my-session', 'mongodb');
```

### Memory Storage

Sessions are stored in memory (lost on restart):

```typescript
await client.createSession('my-session', 'memory');
```

## 📂 Examples

### Basic Multi-Session Bot

```typescript
import WhatsMulti from '@dutakey/whatsmulti';

const client = new WhatsMulti({
    mongoUri: 'mongodb://localhost:27017/whatsmulti-db',
});

// Create multiple sessions
await client.createSession('business', 'mongodb', { printQR: true });
await client.createSession('personal', 'local', { printQR: true });

// Start all sessions
await client.startSession('business');
await client.startSession('personal');

// Handle messages across all sessions
client.on('messages.upsert', async (data, { sessionId }) => {
    const msg = data.messages[0];
    if (msg.key.fromMe) return;
    
    const text = msg.message?.conversation || '';
    
    if (text === 'ping') {
        await client.sendMessage(sessionId, msg, {
            text: `Pong from session: ${sessionId}`
        });
    }
});
```

### Dynamic Session Management

```typescript
import WhatsMulti from '@dutakey/whatsmulti';

const client = new WhatsMulti();

// Load existing sessions on startup
await client.loadSessions();

client.on('messages.upsert', async (data, { sessionId }) => {
    const msg = data.messages[0];
    if (msg.key.fromMe) return;
    
    const text = msg.message?.conversation || '';
    const [command, ...args] = text.split(' ');
    
    switch (command) {
        case '/create':
            const newSessionId = args[0] || `session-${Date.now()}`;
            await client.createSession(newSessionId, 'local');
            await client.startSession(newSessionId);
            
            client.sendMessage(sessionId, msg, {
                text: `Created session: ${newSessionId}`
            });
            break;
            
        case '/list':
            const sessions = await client.getSessions();
            const sessionList = sessions.map(s => 
                `${s.id}: ${s.status} (${s.connectionType})`
            ).join('\n');
            
            client.sendMessage(sessionId, msg, {
                text: `Active sessions:\n${sessionList}`
            });
            break;
            
        case '/qr':
            const targetSession = args[0] || sessionId;
            const qrData = await client.getQr(targetSession);
            
            if (qrData) {
                const buffer = Buffer.from(qrData.image.replace(/^data:image\/png;base64,/, ''), 'base64');
                client.sendMessage(sessionId, msg, {
                    image: buffer,
                    caption: `QR Code for session: ${targetSession}`
                });
            }
            break;
    }
});
```

### Event Logging and Monitoring

```typescript
import WhatsMulti from '@dutakey/whatsmulti';

const client = new WhatsMulti({
    LoggerLevel: 'info',
    BaileysLoggerLevel: 'error'
});

// Monitor all session events
client.process((events, { sessionId }) => {
    Object.entries(events).forEach(([event, data]) => {
        console.log(`[${sessionId}] ${event}:`, data);
    });
});

// Specific event handlers
client.on('open', (_, { sessionId }) => {
    console.log(`✅ Session ${sessionId} connected successfully`);
});

client.on('close', (_, { sessionId }) => {
    console.log(`❌ Session ${sessionId} disconnected`);
});

client.on('qr', (data, { sessionId }) => {
    console.log(`📱 QR Code generated for ${sessionId}`);
    // Save QR code or send to admin
});
```

## 🔷 TypeScript Support

WhatsMulti is built with TypeScript and provides full type definitions:

```typescript
import WhatsMulti, { 
    ConfigType, 
    SessionInstance, 
    ConnectionType,
    MessageContentType,
    EventMap 
} from '@dutakey/whatsmulti';

const config: ConfigType = {
    defaultConnectionType: 'local',
    LoggerLevel: 'info'
};

const client = new WhatsMulti(config);

// Type-safe event handling
client.on('messages.upsert', (data: EventMap['messages.upsert'], meta) => {
    // data is properly typed
    data.messages.forEach(message => {
        // message is typed as WAMessage
    });
});
```

## 🔧 Advanced Configuration

### Custom Logger Configuration

```typescript
const client = new WhatsMulti({
    LoggerLevel: 'debug', // WhatsMulti logs
    BaileysLoggerLevel: 'error', // Baileys logs
});
```

### MongoDB Connection Options

```typescript
const client = new WhatsMulti({
    mongoUri: 'mongodb://username:password@localhost:27017/whatsmulti-db?authSource=admin'
});
```

### Socket Configuration

```typescript
await client.createSession('my-session', 'local', {
    printQR: false,
    qrMaxWaitMs: 30000,
    disableQRRetry: false,
    // Any other Baileys SocketConfig options
    browser: ['WhatsMulti', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
});
```

## 🐛 Error Handling

```typescript
try {
    await client.createSession('my-session', 'local');
    await client.startSession('my-session');
} catch (error) {
    if (error.message === 'Session exists') {
        console.log('Session already exists');
    } else if (error.message === 'Invalid session id') {
        console.log('Invalid session ID format');
    } else {
        console.error('Unexpected error:', error);
    }
}

// Handle connection errors
client.on('close', async (data, { sessionId }) => {
    console.log(`Session ${sessionId} disconnected, attempting to reconnect...`);
    try {
        await client.restartSession(sessionId);
    } catch (error) {
        console.error(`Failed to restart session ${sessionId}:`, error);
    }
});
```

## 📋 Session ID Requirements

Session IDs must follow these rules:
- Only alphanumeric characters, hyphens, and underscores
- No spaces or special characters
- Validated by regex: `/^(?:[\w-]+)$/`

```typescript
// Valid session IDs
await client.createSession('my-session', 'local');
await client.createSession('session_1', 'local');
await client.createSession('business-bot', 'local');

// Invalid session IDs (will throw error)
await client.createSession('my session', 'local'); // spaces not allowed
await client.createSession('session@123', 'local'); // @ not allowed
```

## 🎯 Contributing

Contributions are welcome! If you find a bug, have feature suggestions, or want to improve the project, feel free to open an issue or submit a pull request.

### Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Run linting: `npm run lint`
5. Run the example: `npm run example`

## 📄 License

This project is licensed under **MIT**, allowing free use, modification, and distribution.
