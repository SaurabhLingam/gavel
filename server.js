/**
 * Gavel Auction Platform — Full Server
 *
 * Features:
 *   - SQLite persistence (gavel.db)
 *   - bcrypt password hashing + express-session auth
 *   - WebSocket real-time bidding, auction-closed broadcasts, and private seller/winner chat
 *   - Bid history per auction
 *   - Auction end times (timer-based) + manual early-end by seller
 *   - Winner recorded on close; seller can see winner contact details
 *   - Closed auctions stored separately
 *   - Private chat between seller and winner per auction (persistent, real-time)
 *   - Admin panel routes
 *
 * Install:
 *   npm install express multer better-sqlite3 bcrypt express-session ws
 *
 * Run:
 *   node server.js
 *
 * First-time admin setup:
 *   node -e "const db=require('better-sqlite3')('./gavel.db'); db.prepare(\"UPDATE users SET role='admin' WHERE email='YOUR@EMAIL.com'\").run(); console.log('Done')"
 */

const express    = require('express');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');
const bcrypt     = require('bcrypt');
const session    = require('express-session');
const Database   = require('better-sqlite3');
const http       = require('http');
const { WebSocketServer } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─────────────────────────────────────────────
// 1. DATABASE
// ─────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'gavel.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        fullname      TEXT    NOT NULL,
        email         TEXT    NOT NULL UNIQUE,
        role          TEXT    NOT NULL DEFAULT 'bidder',
        password_hash TEXT    NOT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auctions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        title         TEXT    NOT NULL,
        description   TEXT,
        current_bid   INTEGER NOT NULL,
        image         TEXT,
        video         TEXT,
        verified      INTEGER NOT NULL DEFAULT 0,
        seller_email  TEXT    NOT NULL,
        end_time      DATETIME,
        status        TEXT    NOT NULL DEFAULT 'active',
        winner_email  TEXT,
        winner_name   TEXT,
        winning_bid   INTEGER,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bids (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        auction_id   INTEGER NOT NULL,
        bidder_email TEXT    NOT NULL,
        bidder_name  TEXT    NOT NULL,
        amount       INTEGER NOT NULL,
        placed_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        auction_id   INTEGER NOT NULL,
        sender_email TEXT    NOT NULL,
        sender_name  TEXT    NOT NULL,
        message      TEXT    NOT NULL,
        sent_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE
    );
`);

// Safe migration for older DBs
const existingCols = db.prepare("PRAGMA table_info(auctions)").all().map(c => c.name);
if (!existingCols.includes('end_time'))     db.exec("ALTER TABLE auctions ADD COLUMN end_time DATETIME");
if (!existingCols.includes('status'))       db.exec("ALTER TABLE auctions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
if (!existingCols.includes('winner_email')) db.exec("ALTER TABLE auctions ADD COLUMN winner_email TEXT");
if (!existingCols.includes('winner_name'))  db.exec("ALTER TABLE auctions ADD COLUMN winner_name TEXT");
if (!existingCols.includes('winning_bid'))  db.exec("ALTER TABLE auctions ADD COLUMN winning_bid INTEGER");

// Seed demo auction if empty
const seedCount = db.prepare('SELECT COUNT(*) as c FROM auctions').get();
if (seedCount.c === 0) {
    const oneWeekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO auctions (title, description, current_bid, image, verified, seller_email, end_time, status)
        VALUES (?, ?, ?, ?, 1, ?, ?, 'active')
    `).run(
        'Antique Vase',
        'A rare 19th-century porcelain piece with intricate gold trim and hand-painted floral motifs.',
        12000,
        'https://images.unsplash.com/photo-1695902047073-796e00ccd35f?q=80&w=769',
        'admin@gavel.com',
        oneWeekFromNow
    );
}

// ─────────────────────────────────────────────
// 2. MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'gavel-house-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// ─────────────────────────────────────────────
// 3. FILE UPLOADS
// ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ─────────────────────────────────────────────
// 4. WEBSOCKETS
// Handles three message types:
//   { type: 'watch',     itemId }          — subscribe to auction bid updates
//   { type: 'join_chat', auctionId }       — subscribe to a private chat room
//   { type: 'chat_msg',  auctionId, text } — send a chat message
// ─────────────────────────────────────────────
const watchers  = new Map(); // itemId  → Set<ws>  (bid watchers)
const chatRooms = new Map(); // auctionId → Set<{ws, email, name}> (chat participants)

wss.on('connection', (ws, req) => {
    let watchingId  = null;
    let chatId      = null;
    let userEmail   = null;
    let userName    = null;

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            // ── Auction bid watcher ──
            if (msg.type === 'watch' && msg.itemId) {
                watchingId = String(msg.itemId);
                if (!watchers.has(watchingId)) watchers.set(watchingId, new Set());
                watchers.get(watchingId).add(ws);
            }

            // ── Join a chat room ──
            if (msg.type === 'join_chat' && msg.auctionId && msg.email && msg.name) {
                chatId    = String(msg.auctionId);
                userEmail = msg.email;
                userName  = msg.name;

                if (!chatRooms.has(chatId)) chatRooms.set(chatId, new Set());
                chatRooms.get(chatId).add({ ws, email: userEmail, name: userName });
            }

            // ── Send a chat message ──
            if (msg.type === 'chat_msg' && msg.auctionId && msg.text && userEmail) {
                const aid  = Number(msg.auctionId);
                const text = String(msg.text).trim().slice(0, 2000); // 2000 char limit
                if (!text) return;

                // Verify the sender is the seller or winner of this auction
                const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(aid);
                if (!auction) return;
                if (auction.seller_email !== userEmail && auction.winner_email !== userEmail) return;

                // Persist to DB
                db.prepare('INSERT INTO chat_messages (auction_id, sender_email, sender_name, message) VALUES (?, ?, ?, ?)')
                  .run(aid, userEmail, userName, text);

                // Broadcast to everyone in this chat room
                const payload = JSON.stringify({
                    type:        'chat_msg',
                    auctionId:   aid,
                    senderEmail: userEmail,
                    senderName:  userName,
                    message:     text,
                    sentAt:      new Date().toISOString()
                });

                const room = chatRooms.get(String(aid));
                if (room) {
                    room.forEach(participant => {
                        if (participant.ws.readyState === participant.ws.OPEN)
                            participant.ws.send(payload);
                    });
                }
            }

        } catch(e) {}
    });

    ws.on('close', () => {
        if (watchingId && watchers.has(watchingId))
            watchers.get(watchingId).delete(ws);
        if (chatId && chatRooms.has(chatId)) {
            const room = chatRooms.get(chatId);
            room.forEach(p => { if (p.ws === ws) room.delete(p); });
        }
    });
});

function broadcastAuction(itemId, payload) {
    const room = watchers.get(String(itemId));
    if (!room) return;
    const msg = JSON.stringify(payload);
    room.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(msg); });
}

// ─────────────────────────────────────────────
// 5. AUCTION CLOSE LOGIC
// ─────────────────────────────────────────────
function closeAuction(auctionId) {
    const item = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
    if (!item || item.status === 'closed') return;

    const topBid = db.prepare(`
        SELECT bidder_email, bidder_name, amount FROM bids
        WHERE auction_id = ? ORDER BY amount DESC LIMIT 1
    `).get(auctionId);

    db.prepare(`
        UPDATE auctions
        SET status = 'closed', winner_email = ?, winner_name = ?, winning_bid = ?
        WHERE id = ?
    `).run(
        topBid ? topBid.bidder_email : null,
        topBid ? topBid.bidder_name  : null,
        topBid ? topBid.amount       : null,
        auctionId
    );

    broadcastAuction(auctionId, {
        type:       'auction_closed',
        itemId:     auctionId,
        winnerName: topBid ? topBid.bidder_name : null,
        winningBid: topBid ? topBid.amount      : null,
        noBids:     !topBid
    });

    console.log(`🔨 Auction #${auctionId} "${item.title}" closed. Winner: ${topBid ? topBid.bidder_name + ' @ ₹' + topBid.amount : 'No bids'}`);
}

// Auto-close check every 30 seconds
function checkExpiredAuctions() {
    const expired = db.prepare(`
        SELECT id FROM auctions
        WHERE status = 'active' AND end_time IS NOT NULL AND end_time <= datetime('now')
    `).all();
    expired.forEach(row => closeAuction(row.id));
}
checkExpiredAuctions();
setInterval(checkExpiredAuctions, 30 * 1000);

// ─────────────────────────────────────────────
// 6. HELPERS
// ─────────────────────────────────────────────
function requireLogin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Login required.' });
    next();
}
function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin')
        return res.status(403).json({ success: false, message: 'Admin access required.' });
    next();
}
function auctionRow(row) {
    const bidCount = db.prepare('SELECT COUNT(*) as c FROM bids WHERE auction_id = ?').get(row.id).c;
    return {
        id: row.id, title: row.title, description: row.description,
        currentBid: row.current_bid, image: row.image, verificationVideo: row.video,
        verified: row.verified === 1, sellerEmail: row.seller_email,
        endTime: row.end_time, status: row.status || 'active',
        winnerEmail: row.winner_email, winnerName: row.winner_name, winningBid: row.winning_bid,
        bidCount
    };
}

// ─────────────────────────────────────────────
// 7. AUTH ROUTES
// ─────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
    const { fullname, email, role, password } = req.body;
    if (!fullname || !email || !password) return res.status(400).send('All fields are required.');
    try {
        const hash = await bcrypt.hash(password, 12);
        db.prepare('INSERT INTO users (fullname, email, role, password_hash) VALUES (?, ?, ?, ?)')
          .run(fullname, email.toLowerCase().trim(), role || 'bidder', hash);
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
        req.session.user = { id: user.id, email: user.email, name: user.fullname, role: user.role };
        res.redirect('/index.html');
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).send('An account with this email already exists.');
        res.status(500).send('Server error during signup.');
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase().trim());
    if (!user) return res.status(401).send('Invalid email or password.');
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).send('Invalid email or password.');
    req.session.user = { id: user.id, email: user.email, name: user.fullname, role: user.role };
    res.redirect('/index.html');
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.redirect('/login.html')); });
app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user: req.session.user });
});

// ─────────────────────────────────────────────
// 8. AUCTION ROUTES
// ─────────────────────────────────────────────
app.get('/api/auctions', (req, res) => {
    const rows = db.prepare("SELECT * FROM auctions WHERE status = 'active' ORDER BY end_time ASC").all();
    res.json(rows.map(auctionRow));
});
app.get('/api/auctions/closed', (req, res) => {
    const rows = db.prepare("SELECT * FROM auctions WHERE status = 'closed' ORDER BY created_at DESC").all();
    res.json(rows.map(auctionRow));
});
app.get('/api/auction/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM auctions WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ message: 'Not found' });
    res.json(auctionRow(row));
});

app.post('/api/sell', requireLogin, upload.fields([
    { name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }
]), (req, res) => {
    try {
        const { title, price, description, end_time } = req.body;
        const imageFile  = req.files['image'] ? `/uploads/${req.files['image'][0].filename}` : '/images/logo.png';
        const videoFile  = req.files['video'] ? `/uploads/${req.files['video'][0].filename}` : null;
        const endTimeISO = end_time ? new Date(end_time).toISOString() : null;
        if (endTimeISO && new Date(end_time) <= new Date())
            return res.status(400).send('Auction end time must be in the future.');
        db.prepare(`
            INSERT INTO auctions (title, description, current_bid, image, video, verified, seller_email, end_time, status)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active')
        `).run(title, description, parseInt(price), imageFile, videoFile, req.session.user.email, endTimeISO);
        res.redirect('/my-products.html');
    } catch (err) {
        console.error('Sell error:', err);
        res.status(500).send('Error listing the item.');
    }
});

app.post('/api/place-bid', requireLogin, (req, res) => {
    const { id, bidAmount } = req.body;
    const amount = Number(bidAmount);
    const item = db.prepare('SELECT * FROM auctions WHERE id = ?').get(Number(id));
    if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });
    if (item.status === 'closed') return res.status(400).json({ success: false, message: 'This auction has closed.' });
    if (item.end_time && new Date(item.end_time) <= new Date())
        return res.status(400).json({ success: false, message: 'This auction has expired.' });
    if (item.seller_email === req.session.user.email)
        return res.status(403).json({ success: false, message: 'You cannot bid on your own listing.' });
    if (amount <= item.current_bid)
        return res.status(400).json({ success: false, message: `Bid must exceed ₹${item.current_bid.toLocaleString('en-IN')}.` });

    db.prepare('UPDATE auctions SET current_bid = ? WHERE id = ?').run(amount, Number(id));
    db.prepare('INSERT INTO bids (auction_id, bidder_email, bidder_name, amount) VALUES (?, ?, ?, ?)')
      .run(Number(id), req.session.user.email, req.session.user.name, amount);
    const bidCount = db.prepare('SELECT COUNT(*) as c FROM bids WHERE auction_id = ?').get(Number(id)).c;
    broadcastAuction(id, { type: 'bid_update', itemId: Number(id), newBid: amount, bidCount });
    res.json({ success: true, newBid: amount, bidCount });
});

app.post('/api/end-auction', requireLogin, (req, res) => {
    const { id } = req.body;
    const item = db.prepare('SELECT * FROM auctions WHERE id = ?').get(Number(id));
    if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });
    if (item.status === 'closed') return res.status(400).json({ success: false, message: 'Already closed.' });
    if (item.seller_email !== req.session.user.email && req.session.user.role !== 'admin')
        return res.status(403).json({ success: false, message: 'Only the seller can end this auction.' });
    closeAuction(Number(id));
    res.json({ success: true });
});

app.post('/api/remove-item', requireLogin, (req, res) => {
    const { id } = req.body;
    const item = db.prepare('SELECT * FROM auctions WHERE id = ?').get(Number(id));
    if (!item) return res.status(404).json({ success: false, message: 'Item not found.' });
    if (item.seller_email !== req.session.user.email && req.session.user.role !== 'admin')
        return res.status(403).json({ success: false, message: 'You can only remove your own listings.' });
    const bidCount = db.prepare('SELECT COUNT(*) as c FROM bids WHERE auction_id = ?').get(Number(id)).c;
    if (bidCount > 0 && req.session.user.role !== 'admin')
        return res.status(400).json({ success: false, message: 'Cannot withdraw a lot that already has bids. Use "End Auction" instead.' });
    db.prepare('DELETE FROM auctions WHERE id = ?').run(Number(id));
    res.json({ success: true });
});

app.get('/api/bid-history/:id', (req, res) => {
    const rows = db.prepare(`
        SELECT bidder_name AS bidderName, amount, placed_at
        FROM bids WHERE auction_id = ? ORDER BY amount DESC
    `).all(Number(req.params.id));
    res.json(rows);
});

app.get('/api/auction/:id/winner', requireLogin, (req, res) => {
    const item = db.prepare('SELECT * FROM auctions WHERE id = ?').get(Number(req.params.id));
    if (!item) return res.status(404).json({ message: 'Not found.' });
    if (item.seller_email !== req.session.user.email && req.session.user.role !== 'admin')
        return res.status(403).json({ message: 'Only the seller can view winner details.' });
    if (item.status !== 'closed') return res.status(400).json({ message: 'Auction is still active.' });
    if (!item.winner_email) return res.json({ noBids: true });
    res.json({ noBids: false, name: item.winner_name, email: item.winner_email, winningBid: item.winning_bid });
});

// ─────────────────────────────────────────────
// 9. CHAT ROUTES
// ─────────────────────────────────────────────

// GET chat history — only seller or winner can access
app.get('/api/chat/:auctionId', requireLogin, (req, res) => {
    const auctionId = Number(req.params.auctionId);
    const auction   = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);

    if (!auction) return res.status(404).json({ message: 'Auction not found.' });
    if (auction.status !== 'closed') return res.status(400).json({ message: 'Chat is only available after the auction closes.' });

    const userEmail = req.session.user.email;
    if (auction.seller_email !== userEmail && auction.winner_email !== userEmail)
        return res.status(403).json({ message: 'Only the seller and winner can access this chat.' });

    const messages = db.prepare(`
        SELECT sender_email AS senderEmail, sender_name AS senderName, message, sent_at AS sentAt
        FROM chat_messages WHERE auction_id = ? ORDER BY sent_at ASC
    `).all(auctionId);

    // Also return who the other party is
    const otherEmail = userEmail === auction.seller_email ? auction.winner_email : auction.seller_email;
    const otherUser  = db.prepare('SELECT fullname FROM users WHERE email = ?').get(otherEmail);

    res.json({
        messages,
        auctionTitle: auction.title,
        myEmail:      userEmail,
        otherName:    otherUser ? otherUser.fullname : 'Other Party',
        otherEmail
    });
});

// POST send a message via HTTP (fallback if WebSocket isn't connected yet)
app.post('/api/chat/:auctionId', requireLogin, (req, res) => {
    const auctionId = Number(req.params.auctionId);
    const { message } = req.body;
    const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);

    if (!auction) return res.status(404).json({ message: 'Auction not found.' });
    if (auction.status !== 'closed') return res.status(400).json({ message: 'Chat unavailable — auction still active.' });

    const userEmail = req.session.user.email;
    if (auction.seller_email !== userEmail && auction.winner_email !== userEmail)
        return res.status(403).json({ message: 'Only the seller and winner can chat here.' });

    const text = String(message || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ message: 'Message cannot be empty.' });

    db.prepare('INSERT INTO chat_messages (auction_id, sender_email, sender_name, message) VALUES (?, ?, ?, ?)')
      .run(auctionId, userEmail, req.session.user.name, text);

    const saved = {
        senderEmail: userEmail,
        senderName:  req.session.user.name,
        message:     text,
        sentAt:      new Date().toISOString()
    };

    // Also push via WebSocket to anyone in the chat room
    const wsPayload = JSON.stringify({ type: 'chat_msg', auctionId, ...saved });
    const room = chatRooms.get(String(auctionId));
    if (room) room.forEach(p => { if (p.ws.readyState === p.ws.OPEN) p.ws.send(wsPayload); });

    res.json({ success: true, message: saved });
});

// GET all chats the current user is a party to (inbox)
app.get('/api/my-chats', requireLogin, (req, res) => {
    const email = req.session.user.email;

    // All closed auctions where user is seller or winner
    const auctions = db.prepare(`
        SELECT * FROM auctions
        WHERE status = 'closed'
          AND (seller_email = ? OR winner_email = ?)
        ORDER BY created_at DESC
    `).all(email, email);

    const result = auctions.map(a => {
        // Last message
        const last = db.prepare(`
            SELECT sender_name AS senderName, message, sent_at AS sentAt
            FROM chat_messages WHERE auction_id = ?
            ORDER BY sent_at DESC LIMIT 1
        `).get(a.id);

        // Unread count — messages from the other party not yet seen
        // (simple approximation: messages since last time user sent a message)
        const lastSent = db.prepare(`
            SELECT sent_at FROM chat_messages
            WHERE auction_id = ? AND sender_email = ?
            ORDER BY sent_at DESC LIMIT 1
        `).get(a.id, email);

        const unread = lastSent
            ? db.prepare(`SELECT COUNT(*) as c FROM chat_messages WHERE auction_id = ? AND sender_email != ? AND sent_at > ?`).get(a.id, email, lastSent.sent_at).c
            : db.prepare(`SELECT COUNT(*) as c FROM chat_messages WHERE auction_id = ? AND sender_email != ?`).get(a.id, email).c;

        const otherEmail = email === a.seller_email ? a.winner_email : a.seller_email;
        const otherUser  = db.prepare('SELECT fullname FROM users WHERE email = ?').get(otherEmail);
        const myRole     = email === a.seller_email ? 'seller' : 'winner';

        return {
            auctionId:    a.id,
            auctionTitle: a.title,
            auctionImage: a.image,
            winningBid:   a.winning_bid,
            otherName:    otherUser ? otherUser.fullname : 'Other Party',
            otherEmail,
            myRole,
            lastMessage:  last || null,
            unread,
            hasBuyer:     !!a.winner_email
        };
    }).filter(c => c.hasBuyer); // only include chats where there's actually a winner

    res.json(result);
});

// ─────────────────────────────────────────────
// 10. PROFILE ROUTES
// ─────────────────────────────────────────────
app.get('/api/profile', requireLogin, (req, res) => {
    const user = db.prepare('SELECT id, fullname, email, role, created_at FROM users WHERE id = ?').get(req.session.user.id);
    const activeListings = db.prepare("SELECT COUNT(*) as c FROM auctions WHERE seller_email = ? AND status = 'active'").get(user.email).c;
    const closedListings = db.prepare("SELECT COUNT(*) as c FROM auctions WHERE seller_email = ? AND status = 'closed'").get(user.email).c;
    const totalBids      = db.prepare('SELECT COUNT(*) as c FROM bids WHERE bidder_email = ?').get(user.email).c;
    const activeBids     = db.prepare(`
        SELECT COUNT(*) as c FROM auctions a WHERE status = 'active'
        AND (SELECT bidder_email FROM bids WHERE auction_id = a.id ORDER BY amount DESC LIMIT 1) = ?
    `).get(user.email).c;
    const auctionsWon = db.prepare("SELECT COUNT(*) as c FROM auctions WHERE winner_email = ?").get(user.email).c;
    res.json({ ...user, activeListings, closedListings, totalBids, activeBids, auctionsWon });
});

app.get('/api/my-bids', requireLogin, (req, res) => {
    const rows = db.prepare(`
        SELECT b.amount, b.placed_at, a.title AS auctionTitle, a.status AS auctionStatus,
               a.winner_email, a.id AS auctionId
        FROM bids b JOIN auctions a ON b.auction_id = a.id
        WHERE b.bidder_email = ? ORDER BY b.placed_at DESC LIMIT 30
    `).all(req.session.user.email);
    res.json(rows);
});

// ─────────────────────────────────────────────
// 11. ADMIN ROUTES
// ─────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    res.json({
        totalUsers:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
        totalAuctions: db.prepare('SELECT COUNT(*) as c FROM auctions').get().c,
        pendingCount:  db.prepare("SELECT COUNT(*) as c FROM auctions WHERE verified = 0 AND status = 'active'").get().c,
        totalBids:     db.prepare('SELECT COUNT(*) as c FROM bids').get().c,
        closedCount:   db.prepare("SELECT COUNT(*) as c FROM auctions WHERE status = 'closed'").get().c
    });
});
app.get('/api/admin/pending', requireAdmin, (req, res) => {
    res.json(db.prepare("SELECT * FROM auctions WHERE verified = 0 AND status = 'active' ORDER BY created_at ASC").all().map(auctionRow));
});
app.post('/api/admin/verify', requireAdmin, (req, res) => {
    const { id, approve } = req.body;
    approve ? db.prepare('UPDATE auctions SET verified = 1 WHERE id = ?').run(Number(id))
            : db.prepare('DELETE FROM auctions WHERE id = ?').run(Number(id));
    res.json({ success: true });
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, fullname, email, role, created_at FROM users ORDER BY created_at DESC').all());
});
app.post('/api/admin/promote', requireAdmin, (req, res) => {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(Number(req.body.id));
    res.json({ success: true });
});
app.post('/api/admin/close-auction', requireAdmin, (req, res) => {
    closeAuction(Number(req.body.id));
    res.json({ success: true });
});

// ─────────────────────────────────────────────
// 12. START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🔨 Gavel is open at http://localhost:${PORT}`);
    console.log(`   Database  : gavel.db`);
    console.log(`   Auto-close: checks every 30 seconds\n`);
});