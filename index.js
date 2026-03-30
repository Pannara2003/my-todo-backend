const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// --- 1. นำเข้า Library สำหรับ Cloudinary ---
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(express.json());

// --- 2. ตั้งค่า CORS ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], 
    allowedHeaders: ['Content-Type', 'Authorization']
}));

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

// --- 4. ตั้งค่า Cloudinary ---
cloudinary.config({ 
  cloud_name: 'druaw4oi7',
  api_key: '535754114174867',
  api_secret: 'CRZiXMy-9b18hqippFDxM_D8XgQ'
});

// --- 5. ตั้งค่า Storage ให้เก็บรูปบน Cloud ---
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'todo-buddy-profiles',
    allowed_formats: ['jpg', 'png', 'jpeg'],
    transformation: [{ width: 500, height: 500, crop: 'limit' }]
  },
});
const upload = multer({ storage: storage });

// --- 6. Middleware ตรวจสอบสิทธิ์ ---
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

// --- 7. AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [existing] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ message: "email already exists" });
        const hashedPassword = await bcrypt.hash(password, 10);
        const name = email.split('@')[0];
        await db.execute('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name, email, hashedPassword]);
        res.status(201).json({ message: "user registered" });
    } catch (err) { res.status(500).json({ message: "registration failed" }); }
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

// --- 8. API อัปโหลดรูปโปรไฟล์ ---
app.post('/api/profile/upload', authenticateToken, upload.single('profile_image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "no file uploaded" });
        const imageUrl = req.file.path;
        await db.execute('UPDATE users SET profile_image = ? WHERE id = ?', [imageUrl, req.user.id]);
        res.json({ message: "profile image updated", profile_image: imageUrl });
    } catch (err) {
        res.status(500).json({ message: "failed to upload image" });
    }
});

// --- 9. TODO ROUTES ---
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

// --- เพิ่มส่วนแก้ไข Task (PUT) และ สลับสถานะ (PATCH) ---
app.put('/api/todos/:id', authenticateToken, async (req, res) => {
    const { title, description, task_type, start_date, due_date, priority, status } = req.body;
    try {
        const sql = `UPDATE todos SET title = ?, description = ?, task_type = ?, start_date = ?, due_date = ?, priority = ?, status = ? WHERE id = ? AND user_id = ?`;
        await db.execute(sql, [title, description || '', task_type, start_date || null, due_date || null, priority, status, req.params.id, req.user.id]);
        res.json({ message: "task updated" });
    } catch (err) { res.status(500).json({ message: "update error" }); }
});

app.patch('/api/todos/:id/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    try {
        await db.execute('UPDATE todos SET status = ? WHERE id = ? AND user_id = ?', [status, req.params.id, req.user.id]);
        res.json({ message: "status updated" });
    } catch (err) { res.status(500).json({ message: "patch error" }); }
});

app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
    try {
        await db.execute('DELETE FROM todos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ message: "deleted" });
    } catch (err) { res.status(500).json({ message: "delete error" }); }
});

// --- 10. START SERVER ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 backend system active on port ${PORT}`);
});