const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const app = express();

// 1. Setup Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 2. Ensure Uploads Directory exists
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 3. Configure Multer for Image and Video Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Saves file with a unique timestamp to prevent overwriting
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// 4. In-Memory "Database"
// We use a simple array to store our auction items during this session
let auctions = [
    { 
        id: 1,
        title: "Antique Vase", 
        description: "A rare 19th-century porcelain piece with gold trim.", 
        currentBid: 12000, 
        image: "https://images.unsplash.com/photo-1695902047073-796e00ccd35f?q=80&w=769",
        verified: true,
        sellerEmail: "admin@gavel.com"
    }
];

// --- ROUTES ---

// Serve Home Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Get all auctions for the frontend
app.get('/api/auctions', (req, res) => {
    res.json(auctions);
});

// API: Handle Selling with unique IDs and Seller Tracking
app.post('/api/sell', upload.fields([
    { name: 'image', maxCount: 1 }, 
    { name: 'video', maxCount: 1 }
]), (req, res) => {
    try {
        const { title, price, description } = req.body;
        
        // Extract local file paths saved by Multer
        const imageFile = req.files['image'] ? `/uploads/${req.files['image'][0].filename}` : "/images/logo.png";
        const videoFile = req.files['video'] ? `/uploads/${req.files['video'][0].filename}` : null;

        const newItem = {
            id: Date.now(), // Unique ID based on the exact millisecond of upload
            title,
            description,
            currentBid: parseInt(price),
            image: imageFile, 
            verificationVideo: videoFile,
            verified: false,
            sellerEmail: "saurabh@gavel.com" // Simulated session email
        };

        auctions.push(newItem);
        console.log(`New Lot Authorized: ${title} (ID: ${newItem.id})`);
        
        // Redirect directly to the management dashboard
        res.redirect('/my-products.html'); 
    } catch (error) {
        console.error("Consignment Error:", error);
        res.status(500).send("Error authorizing the listing.");
    }
});

// API: Remove a specific item using its Unique ID
app.post('/api/remove-item', (req, res) => {
    const { id } = req.body;
    const initialLength = auctions.length;
    
    // Filter the array to remove only the item matching this specific ID
    auctions = auctions.filter(item => item.id !== Number(id));

    if (auctions.length < initialLength) {
        console.log(`Item ID ${id} withdrawn from the house.`);
        res.json({ success: true, message: "Lot withdrawn successfully." });
    } else {
        res.status(404).json({ success: false, message: "Lot not found." });
    }
});

app.post('/api/place-bid', (req, res) => {
    const { id, bidAmount } = req.body;

    const item = auctions.find(a => a.id === Number(id));

    if (!item) {
        return res.status(404).json({ success: false, message: "Item not found" });
    }

    if (Number(bidAmount) <= item.currentBid) {
        return res.status(400).json({ 
            success: false, 
            message: "Bid must be higher than current bid" 
        });
    }

    item.currentBid = Number(bidAmount);

    res.json({ 
        success: true, 
        message: "Bid placed successfully", 
        newBid: item.currentBid 
    });
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Gavel server ringing at http://localhost:${PORT}`);
});