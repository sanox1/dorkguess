const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const PORT = 5502;

const { rateLimit } = require('express-rate-limit');

// ===== Rate limit =====
const limiter = rateLimit({
    windowMs: 60 * 1000,     // 1 minute
    max: 60,                 // 60 requests/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});



// Tighter for auth:
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 min
    max: 10,
    message: { error: 'Too many attempts, try again later.' }
});

// ===== RPC Configuration =====
const RPC_URL = 'http://127.0.0.1:22555';
const RPC_USER = 'YOUR_RPC_USER';
const RPC_PASS = 'YOUR_RPC_PASS';

// ===== BTC Price API (freecryptoapi.com) =====
const BTC_API_BASE = 'https://api.freecryptoapi.com/v1';
const BTC_API_KEY = 'YOUR_FREECRYPTOAPI_KEY'; // your freecryptoapi key

// ===== Config =====
const REWARD_AMOUNT = 10;            // 10 DORK
const POINTS_TO_WIN = 5;            // 5 correct predictions needed
const LIVES_PER_DAY = 10;
const PREDICTION_LOCK_MS = 60 * 1000; // 1 min 
const DATA_FILE = path.join(__dirname, 'users.json');
const REWARDS_FILE = path.join(__dirname, 'rewards.json');
//const PRICE_HISTORY_FILE = path.join(__dirname, 'price_history.json');

app.use(cors({
    origin: [
        'http://dorkguess.biz.ht',
        'http://www.dorkguess.biz.ht',
        'http://localhost:5502',
        'http://127.0.0.1:5502'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-username', 'x-auth-token']
}));

app.use(express.json());

// Apply globally, or to specific routes:
app.use('/api/', limiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// ===== Helpers =====
function loadJSON(file, defaultValue = {}) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.error('loadJSON error for', file, e);
        return defaultValue;
    }
}

function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ===== RPC Helper =====
async function rpcCall(method, params = []) {
    try {
        const response = await axios.post(
            RPC_URL,
            {
                jsonrpc: '1.0',
                id: Date.now(),
                method: method,
                params: params
            },
            {
                auth: {
                    username: RPC_USER,
                    password: RPC_PASS
                },
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );
        if (response.data.error) {
            throw new Error(response.data.error.message || JSON.stringify(response.data.error));
        }
        return response.data.result;
    } catch (e) {
        console.error(`RPC ${method} failed:`, e.message);
        throw e;
    }
}

// ===== Validate DORK address (34 chars, starts with D) =====
function isValidDorkAddress(address) {
    if (!address || typeof address !== 'string') return false;
    address = address.trim();
    if (address.length !== 34) return false;
    if (!address.startsWith('D')) return false;
    return /^[A-Za-z0-9]+$/.test(address);
}

// ===== Get current UTC day key (for lives reset at 12:00 UTC) =====
// A "game day" starts at 12:00 UTC and ends at next 12:00 UTC.
function getGameDayKey(date = new Date()) {
    const d = new Date(date);
    // If before 12:00 UTC, it belongs to previous day's game day
    if (d.getUTCHours() < 12) {
        d.setUTCDate(d.getUTCDate() - 1);
    }
    return d.toISOString().slice(0, 10); // YYYY-MM-DD of the game day start
}

// ===== Ensure user has correct state for today =====
function refreshUserDailyState(user) {
    const todayKey = getGameDayKey();
    if (user.lastResetDay !== todayKey) {
        user.lives = LIVES_PER_DAY;
        user.lastResetDay = todayKey;
        // Note: score is NOT reset (persistent)
    }
    return user;
}


// ===== Fetch BTC price from freecryptoapi.com =====
const priceCache = {
    price: null,
    fetchedAt: 0
};


// ===== Rolling price history (last 15 minutes) =====
const HISTORY_WINDOW_MS = 15 * 60 * 1000;
const priceHistory = [];

function recordPrice(price) {
    const now = Date.now();
    const last = priceHistory[priceHistory.length - 1];
    if (last && now - last.t < 20 * 1000) return; // debounce
    priceHistory.push({ t: now, p: price });
    const cutoff = now - HISTORY_WINDOW_MS;
    while (priceHistory.length && priceHistory[0].t < cutoff) priceHistory.shift();
}

async function fetchBtcPrice(forceFresh = false) {
    const now = Date.now();
    // Cache for 3s to match the API update rate
    const CACHE_TTL = forceFresh ? 0 : 30000;
    if (priceCache.price && now - priceCache.fetchedAt < CACHE_TTL) {
        return priceCache.price;
    }

    try {
        const resp = await axios.get(`${BTC_API_BASE}/getData?symbol=BTC`, {
            headers: {
                'Authorization': `Bearer ${BTC_API_KEY}`,
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        const d = resp.data;
        let price = null;

        // Expected shape:
        // { status: "success", symbols: [ { symbol: "BTC", last: "84112.28", ... } ] }
        if (d && d.status === 'success' && Array.isArray(d.symbols)) {
            const btc = d.symbols.find(x => x.symbol === 'BTC') || d.symbols[0];
            if (btc && btc.last !== undefined) {
                price = Number(btc.last);
            }
        }

        if (!price || isNaN(price) || price <= 0) {
            throw new Error('Could not parse price from response: ' + JSON.stringify(d));
        }

        priceCache.price = price;
        priceCache.fetchedAt = now;
		recordPrice(price);          // ← only on fresh fetch
        return price;
    } catch (e) {
        console.error('BTC fetch failed:', e.message);
        if (priceCache.price) return priceCache.price; // fallback to stale
        throw e;
    }
}

// ===== Resolve any pending predictions that are older than 1 hour =====
async function resolvePendingPredictions(user, currentPrice) {
    if (!user.pendingPrediction) return { resolved: false };

    const elapsed = Date.now() - user.pendingPrediction.timestamp;
    if (elapsed < PREDICTION_LOCK_MS) {
        return { resolved: false }; // still locked
    }

    // Resolve
    const entryPrice = user.pendingPrediction.entryPrice;
    const direction = user.pendingPrediction.direction;
    let correct = false;

    if (direction === 'UP') correct = currentPrice > entryPrice;
    if (direction === 'DOWN') correct = currentPrice < entryPrice;

    // If equal price, treat as loss (no change) - or you could refund life
    if (currentPrice === entryPrice) correct = false;

    if (correct) {
        user.score += 1;
    } else {
        user.score = Math.max(0, user.score - 1); //cannot be a negative number 
    }

    user.lastResult = {
        direction,
        entryPrice,
        exitPrice: currentPrice,
        correct,
        resolvedAt: Date.now()
    };

    user.pendingPrediction = null;

    // ===== Check for reward =====
    let rewardPaid = null;
    if (user.score >= POINTS_TO_WIN) {
        try {
            const txid = await sendReward(user.username, REWARD_AMOUNT);
            user.score -= POINTS_TO_WIN; // deduct 10 points
            rewardPaid = { txid, amount: REWARD_AMOUNT, at: Date.now() };
            user.lastReward = rewardPaid;

            // Log reward
            const rewards = loadJSON(REWARDS_FILE, []);
            rewards.push({
                username: user.username,
                amount: REWARD_AMOUNT,
                txid,
                at: Date.now()
            });
            saveJSON(REWARDS_FILE, rewards);

            console.log(`🎉 Reward paid to ${user.username}: ${REWARD_AMOUNT} DORK (tx: ${txid})`);
        } catch (e) {
            console.error(`Reward failed for ${user.username}:`, e.message);
            // Score NOT deducted if send failed, so user can retry next win
        }
    }

    return { resolved: true, correct, rewardPaid, newScore: user.score };
}

// ===== Send DORK coins via RPC =====
async function sendReward(address, amount) {
    if (!isValidDorkAddress(address)) {
        throw new Error('Invalid reward address: ' + address);
    }
    // sendtoaddress <address> <amount>
    const txid = await rpcCall('sendtoaddress', [address, amount]);
    return txid;
}

// ===== Cleanup helper: resolve all pending for a user (called on /stats) =====
async function processUser(user, currentPrice) {
    refreshUserDailyState(user);
    await resolvePendingPredictions(user, currentPrice);
    return user;
}

// ============================================================
// ============== API ROUTES ==================================
// ============================================================

// ===== Register =====
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password required' });
        }
        if (!isValidDorkAddress(username)) {
            return res.status(400).json({ success: false, error: 'Username must be a valid 34-char DORK address starting with D' });
        }
        if (password.length < 4) {
            return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
        }

        // INSERT THE RPC CHECK HERE 
        // Verify the address actually exists on the DORK chain
        try {
            const v = await rpcCall('validateaddress', [username]);
            if (!v.isvalid) {
                return res.status(400).json({ success: false, error: 'Address is not valid on the DORK chain' });
            }
        } catch (e) {
            console.warn('validateaddress failed:', e.message);
            // continue anyway if RPC is unavailable (e.g. DORKCORE not running)
        }


        const users = loadJSON(DATA_FILE, {});
        if (users[username]) {
            return res.status(409).json({ success: false, error: 'User already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        users[username] = {
            username,
            passwordHash,
            score: 0,
            lives: LIVES_PER_DAY,
            lastResetDay: getGameDayKey(),
            pendingPrediction: null,
            lastResult: null,
            lastReward: null,
            createdAt: Date.now()
        };
        saveJSON(DATA_FILE, users);

        res.json({ success: true, message: 'Registration successful' });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== Login =====
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password required' });
        }
        const users = loadJSON(DATA_FILE, {});
        const user = users[username];
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ success: false, error: 'Wrong password' });

        // Simple token: HMAC of username+secret
        const token = crypto
            .createHmac('sha256', 'your_dorkguess_secret')
            .update(username)
            .digest('hex');

        res.json({
            success: true,
            username: user.username,
            score: user.score,
            lives: user.lives,
            token
        });
    } catch (e) {
        console.error('login error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== Auth middleware (simple token check) =====
function requireAuth(req, res, next) {
    const token = req.headers['x-auth-token'];
    const username = req.headers['x-username'];
    if (!token || !username) return res.status(401).json({ error: 'Unauthorized' });

    const expected = crypto
        .createHmac('sha256', 'your_dorkguess_secret')
        .update(username)
        .digest('hex');

    if (token !== expected) return res.status(401).json({ error: 'Invalid token' });
    req.username = username;
    next();
}

// ===== Can wallet play? (public check by address) =====
app.get('/api/canwalletplay/:address', async (req, res) => {
    try {
        const address = req.params.address;
        if (!isValidDorkAddress(address)) {
            return res.json({ canPlay: false, error: 'Invalid address' });
        }
        const users = loadJSON(DATA_FILE, {});
        const user = users[address];
        if (!user) {
            return res.json({ canPlay: false, error: 'User not registered. Please sign up.' });
        }

        // Resolve any pending predictions first
        const currentPrice = await fetchBtcPrice(false);
        await processUser(user, currentPrice);
        saveJSON(DATA_FILE, users);

        const locked = user.pendingPrediction &&
            (Date.now() - user.pendingPrediction.timestamp < PREDICTION_LOCK_MS);

        res.json({
            canPlay: user.lives > 0 && !locked,
            hasPlayed: user.lives <= 0,
            locked,
            lives: user.lives,
            score: user.score,
            pendingPrediction: user.pendingPrediction
        });
    } catch (e) {
        console.error('canwalletplay error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ===== Place prediction (UP or DOWN) =====
app.post('/api/predict', requireAuth, async (req, res) => {
    try {
        const username = req.username;
        const { direction } = req.body; // 'UP' or 'DOWN'
        if (direction !== 'UP' && direction !== 'DOWN') {
            return res.status(400).json({ success: false, error: 'direction must be UP or DOWN' });
        }

        const users = loadJSON(DATA_FILE, {});
        const user = users[username];
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

		const currentPrice = await fetchBtcPrice(true);

        // First resolve any expired prediction
        await resolvePendingPredictions(user, currentPrice);

        // Refresh daily lives
        refreshUserDailyState(user);

        // Check locks
        if (user.pendingPrediction) {
            const elapsed = Date.now() - user.pendingPrediction.timestamp;
            if (elapsed < PREDICTION_LOCK_MS) {
                const remaining = Math.ceil((PREDICTION_LOCK_MS - elapsed) / 1000);
                saveJSON(DATA_FILE, users);
                return res.status(423).json({
                    success: false,
                    error: 'Prediction locked',
                    secondsRemaining: remaining
                });
            }
        }

        if (user.lives <= 0) {
            saveJSON(DATA_FILE, users);
            return res.status(403).json({ success: false, error: 'No lives left today. Come back after 12:00 UTC.' });
        }

        // Record prediction
        user.lives -= 1;
        user.pendingPrediction = {
            direction,
            entryPrice: currentPrice,
            timestamp: Date.now()
        };

        saveJSON(DATA_FILE, users);

		res.json({
			success: true,
			direction,
			entryPrice: currentPrice,
			lives: user.lives,
			score: user.score,
			lockDurationMs: PREDICTION_LOCK_MS  // how long the lock lasts
		});
    } catch (e) {
        console.error('predict error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== Price history (public) =====
app.get('/api/price-history', (req, res) => {
    res.json({
        window: HISTORY_WINDOW_MS,
        points: priceHistory
    });
});

// ===== Stats (per user, requires auth) =====
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const users = loadJSON(DATA_FILE, {});
        const user = users[req.username];
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Refresh lives first (may reset at 12:00 UTC)
        refreshUserDailyState(user);

        // If user has no lives AND no pending prediction, skip the BTC fetch entirely
        const hasPending = !!user.pendingPrediction;
        let currentPrice = priceCache.price; // may be null on cold start

        if (user.lives > 0 || hasPending) {
            currentPrice = await fetchBtcPrice();
            await resolvePendingPredictions(user, currentPrice);
        }

        saveJSON(DATA_FILE, users);

        const locked = user.pendingPrediction &&
            (Date.now() - user.pendingPrediction.timestamp < PREDICTION_LOCK_MS);

        const secondsRemaining = (locked && user.pendingPrediction)
            ? Math.max(0, Math.ceil((PREDICTION_LOCK_MS - (Date.now() - user.pendingPrediction.timestamp)) / 1000))
            : 0;

        res.json({
            username: user.username,
            score: user.score,
            lives: user.lives,
            btcPrice: currentPrice,          // may be null / stale
            pendingPrediction: user.pendingPrediction,
            locked,
            secondsRemaining,
            lockDurationMs: PREDICTION_LOCK_MS,
            lastResult: user.lastResult,
            lastReward: user.lastReward,
			priceHistory: priceHistory.slice(-30) // last 30 points
        });
    } catch (e) {
        console.error('stats error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ===== Global stats (public) =====
app.get('/api/guessstats', async (req, res) => {
    try {
        const users = loadJSON(DATA_FILE, {});
        const list = Object.values(users);
        const totalUsers = list.length;
        const totalScore = list.reduce((s, u) => s + (u.score || 0), 0);
        const totalRewardsPaid = list.filter(u => u.lastReward).length;

        let btcPrice = null;
        try { btcPrice = await fetchBtcPrice(); } catch (e) {}

        res.json({
            totalUsers,
            totalScore,
            totalRewardsPaid,
            btcPrice
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

 
// ===== Health check =====
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ===== Periodic background resolver (every 5 minutes) =====
setInterval(async () => {
    try {
        const users = loadJSON(DATA_FILE, {});
        let changed = false;
        let price;
        try { price = await fetchBtcPrice(); } catch (e) { return; }

        for (const username of Object.keys(users)) {
            const before = JSON.stringify(users[username].pendingPrediction);
            await processUser(users[username], price);
            const after = JSON.stringify(users[username].pendingPrediction);
            if (before !== after) changed = true;
        }
        if (changed) {
            saveJSON(DATA_FILE, users);
            console.log('[bg] Resolved pending predictions');
        }
    } catch (e) {
        console.error('[bg] error:', e.message);
    }
}, 5 * 60 * 1000);

// ===== Start =====
app.listen(PORT, () => {
    console.log(`🚀 Dorkguess backend running on http://localhost:${PORT}`);
    console.log(`📁 Data file: ${DATA_FILE}`);
    console.log(`🔗 RPC: ${RPC_URL}`);
});
