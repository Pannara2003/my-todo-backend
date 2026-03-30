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
app.use(cors());

// --- 1. จัดการโฟลเดอร์สำหรับอัปโหลดรูปโปรไฟล์ ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// --- 2. การเชื่อมต่อ Database ---
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '', 
    database: 'todo_db',
    waitForConnections: true,
    connectionLimit: 10
});

const JWT_SECRET = 'my_super_secret_123';

// --- 3. Middleware ตรวจสอบสิทธิ์ (JWT) ---
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

// --- 4. การตั้งค่า Multer (Profile Image) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- 5. AUTH ROUTES ---

// 🔥 [REGISTER] เพิ่มส่วนนี้เพื่อให้กดสมัครสมาชิกได้
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        // เช็คว่ามีอีเมลนี้หรือยัง
        const [existing] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ message: "email already exists" });
        }

        // เข้ารหัสพาสเวิร์ด
        const hashedPassword = await bcrypt.hash(password, 10);
        const name = email.split('@')[0]; // ตั้งชื่อเริ่มต้นจากหน้าอีเมล

        await db.execute(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );

        res.status(201).json({ message: "user registered" });
    } catch (err) {
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
        
        res.json({ 
            token, 
            user: {
                id: user.id,
                name: user.name,
                profile_image: user.profile_image 
                    ? `http://localhost:5000${user.profile_image}` 
                    : null
            }
        });
    } catch (err) {
        res.status(500).json({ message: "server error" });
    }
});

app.post('/api/user/profile-image', authenticateToken, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "no file uploaded" });
    const imageUrl = `/uploads/${req.file.filename}`;
    try {
        await db.execute('UPDATE users SET profile_image = ? WHERE id = ?', [imageUrl, req.user.id]);
        res.json({ imageUrl: `http://localhost:5000${imageUrl}` });
    } catch (err) {
        res.status(500).json({ message: "database update failed" });
    }
});

// --- 6. TODO ROUTES ---

// [CREATE] เพิ่มงานใหม่
app.post('/api/todos', authenticateToken, async (req, res) => {
    const { title, description, task_type, start_date, due_date, priority, status } = req.body;
    try {
        const sql = `
            INSERT INTO todos 
            (user_id, title, description, task_type, start_date, due_date, priority, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
            req.user.id, 
            title, 
            description || '', 
            task_type || 'Project Task', 
            (start_date && start_date !== '') ? start_date : null, 
            (due_date && due_date !== '') ? due_date : null, 
            priority || 'Medium', 
            status || 'pending'
        ];
        await db.execute(sql, params);
        res.status(201).json({ message: "task created" });
    } catch (err) {
        res.status(500).json({ message: "insert error" });
    }
});

// [READ]
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

        res.json({
            data: rows,
            totalPages: Math.ceil(total / limit) || 1,
            totalItems: total
        });
    } catch (err) {
        res.status(500).json({ message: "fetch error" });
    }
});

// [UPDATE - FULL]
app.put('/api/todos/:id', authenticateToken, async (req, res) => {
    const { title, description, task_type, start_date, due_date, priority, status } = req.body;
    try {
        const sql = `
            UPDATE todos 
            SET title = ?, description = ?, task_type = ?, start_date = ?, due_date = ?, priority = ?, status = ?
            WHERE id = ? AND user_id = ?
        `;
        
        const params = [
            title, 
            description || '', 
            task_type || 'Project Task', 
            (start_date && start_date !== '') ? start_date : null, 
            (due_date && due_date !== '') ? due_date : null, 
            priority || 'Medium', 
            status || 'pending', 
            req.params.id, 
            req.user.id
        ];

        const [result] = await db.execute(sql, params);
        if (result.affectedRows === 0) return res.status(404).json({ message: "task not found" });
        
        res.json({ message: "updated successfully" });
    } catch (err) {
        res.status(500).json({ message: "update error" });
    }
});

// [UPDATE - STATUS ONLY]
app.patch('/api/todos/:id/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    try {
        await db.execute(
            'UPDATE todos SET status = ? WHERE id = ? AND user_id = ?',
            [status, req.params.id, req.user.id]
        );
        res.json({ message: "status updated" });
    } catch (err) {
        res.status(500).json({ message: "update status failed" });
    }
});

// [DELETE]
app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
    try {
        await db.execute('DELETE FROM todos WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ message: "deleted" });
    } catch (err) {
        res.status(500).json({ message: "delete error" });
    }
});

// --- 7. START SERVER ---
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`🚀 backend system active: http://localhost:${PORT}`);
});