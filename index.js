const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- 1. แก้ไขส่วน CORS ให้รองรับการ Deploy (สำคัญมาก!) ---
app.use(cors({
    origin: '*', // อนุญาตให้ทุก Domain (รวมถึง Vercel) เข้าถึงได้
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// --- 2. จัดการโฟลเดอร์สำหรับอัปโหลดรูปโปรไฟล์ ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// --- 3. การเชื่อมต่อ Database (TiDB Cloud) ---
const db = mysql.createPool({
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
    user: '49QkULrURbVakzn.root', 
    password: 'u7CRYFxQYL1g864b', 
    database: 'test', 
    port: 4000,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
});

const JWT_SECRET = 'my_super_secret_123';

// --- 4. Middleware ตรวจสอบสิทธิ์ ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: "access denied" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "invalid token" });
        req.user = user;
        next();
    });
};

// --- 5. การตั้งค่า Multer ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- 6. AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [existing] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ message: "email already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const name = email.split('@')[0];
        await db.execute('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name, email, hashedPassword]);
        res.status(201).json({ message: "user registered" });
    } catch (err) { 
        console.error("Register Error:", err);
        res.status(500).json({ message: "registration failed" }); 
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        const user = users[0];
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: "email or password incorrect" });
        }
        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ token, user: { id: user.id, name: user.name, profile_image: user.profile_image } });
    } catch (err) { res.status(500).json({ message: "server error" }); }
});

// --- 7. TODO ROUTES ---
app.get('/api/todos', authenticateToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const status = req.query.status || 'all'; 
    const limit = 5;
    const offset = (page - 1) * limit;
    try {
        let sql, countSql, params;
        if (status === 'all' || status === '') {
            sql = `SELECT * FROM todos WHERE user_id = ? ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`;
            countSql = `SELECT COUNT(*) as total FROM todos WHERE user_id = ?`;
            params = [req.user.id];
        } else {
            sql = `SELECT * FROM todos WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`;
            countSql = `SELECT COUNT(*) as total FROM todos WHERE user_id = ? AND status = ?`;
            params = [req.user.id, status];
        }
        const [rows] = await db.execute(sql, params);
        const [[{ total }]] = await db.execute(countSql, params);
        res.json({ data: rows, totalPages: Math.ceil(total / limit) || 1, totalItems: total });
    } catch (err) { res.status(500).json({ message: "fetch error" }); }
});

app.post('/api/todos', authenticateToken, async (req, res) => {
    const { title, description, task_type, start_date, due_date, priority, status } = req.body;
    try {
        const sql = `INSERT INTO todos (user_id, title, description, task_type, start_date, due_date, priority, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.execute(sql, [req.user.id, title, description || '', task_type || 'Project Task', start_date || null, due_date || null, priority || 'Medium', status || 'pending']);
        res.status(201).json({ message: "task created" });
    } catch (err) { res.status(500).json({ message: "insert error" }); }
});

app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
    try {
        await db.execute('DELETE FROM todos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ message: "deleted" });
    } catch (err) { res.status(500).json({ message: "delete error" }); }
});

// --- 8. START SERVER ---
const PORT = process.env.PORT || 10000; // ปรับเป็น 10000 ให้เข้ากับ Default ของ Render
app.listen(PORT, () => {
    console.log(`🚀 backend system active on port ${PORT}`);
});