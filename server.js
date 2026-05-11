const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const helmet = require('helmet');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'bmmu-super-secret-key-2026';

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Session management
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Email configuration (optional - won't break if not configured)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'demo@ethereal.email',
    pass: process.env.SMTP_PASS || 'demopass'
  }
});

// Helper to get client info
const getClientInfo = (req) => {
  const userAgent = req.headers['user-agent'] || 'Unknown';
  let device = 'Unknown Device';
  let os = 'Unknown OS';
  let browser = 'Unknown Browser';
  
  if (userAgent.includes('iPhone')) { device = 'iPhone'; os = 'iOS'; }
  else if (userAgent.includes('Android')) { device = 'Android Phone'; os = 'Android'; }
  else if (userAgent.includes('iPad')) { device = 'iPad'; os = 'iOS'; }
  else if (userAgent.includes('Windows')) { device = 'PC'; os = 'Windows'; }
  else if (userAgent.includes('Mac')) { device = 'Mac'; os = 'macOS'; }
  
  if (userAgent.includes('Chrome')) browser = 'Chrome';
  else if (userAgent.includes('Safari')) browser = 'Safari';
  else if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Edge')) browser = 'Edge';
  
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
  
  return { device, os, browser, ip, userAgent };
};

// Send login notification email
async function sendLoginNotification(email, name, clientInfo) {
  if (!email || email === 'demo@ethereal.email') return;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 500px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; }
        .alert-box { background: #e8f4f8; border-left: 4px solid #0d6efd; padding: 15px; margin: 20px 0; border-radius: 5px; }
        .device-info { background: white; padding: 15px; border-radius: 8px; margin: 10px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
        .badge { display: inline-block; padding: 3px 8px; background: #e9ecef; border-radius: 4px; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>🔐 BMMU Security Alert</h2>
          <p>New Sign-in to Your Account</p>
        </div>
        <div class="content">
          <p>Hello <strong>${name}</strong>,</p>
          <p>We detected a new sign-in to your BMMU Member Management System account.</p>
          
          <div class="alert-box">
            <strong>📱 Device Information:</strong>
            <div class="device-info">
              <div><span class="badge">🖥️ Device</span> ${clientInfo.device}</div>
              <div><span class="badge">💿 OS</span> ${clientInfo.os}</div>
              <div><span class="badge">🌐 Browser</span> ${clientInfo.browser}</div>
              <div><span class="badge">📍 IP Address</span> ${clientInfo.ip}</div>
              <div><span class="badge">⏰ Time</span> ${new Date().toLocaleString()}</div>
            </div>
          </div>
          
          <p><strong>Was this you?</strong></p>
          <ul>
            <li>✅ If yes, you can ignore this email.</li>
            <li>⚠️ If not, please contact your system administrator immediately.</li>
          </ul>
          
          <hr style="margin: 20px 0;">
          <p style="font-size: 13px; color: #666;">This is an automated security notification from the BMMU Member Management System.</p>
        </div>
        <div class="footer">
          <p>Buganda Muslim Mass Union | Republic of Uganda</p>
          <p>© ${new Date().getFullYear()} All Rights Reserved</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  try {
    await transporter.sendMail({
      from: '"BMMU System" <security@bmmu.go.ug>',
      to: email,
      subject: `🔐 Security Alert: New sign-in to your BMMU account from ${clientInfo.device}`,
      html: html
    });
  } catch (err) {
    console.log('Email notification skipped (no email configured)');
  }
}

// ============ AUTH MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1] || req.session?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ============ AUTH API ============
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM staff WHERE username = $1 AND active = true',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    
    // Send login notification email (don't await - don't block)
    const clientInfo = getClientInfo(req);
    if (user.email && user.email !== 'demo@ethereal.email') {
      sendLoginNotification(user.email, user.name, clientInfo).catch(console.log);
    }
    
    req.session.token = token;
    req.session.userId = user.id;
    
    const { password: _, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/verify', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM staff WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const { password, ...user } = result.rows[0];
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ MEMBERS API ============
app.get('/api/members', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m
      LEFT JOIN family_members f ON m.id = f.member_id
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/members/:id', authenticateToken, async (req, res) => {
  try {
    const memberResult = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (memberResult.rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    const familyResult = await pool.query('SELECT * FROM family_members WHERE member_id = $1', [req.params.id]);
    const member = memberResult.rows[0];
    member.family = familyResult.rows;
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/members', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, dob, gender, religion, nationality, ninNumber, area, village, phone, phone2, email, occupation, education, maritalStatus, notes, photo, family } = req.body;
    
    const idResult = await client.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM members');
    const nextId = idResult.rows[0].next_id;
    const memberId = `BMMU-${String(nextId).padStart(5, '0')}`;
    
    const memberResult = await client.query(
      `INSERT INTO members (member_id, name, dob, gender, religion, nationality, nin_number, area, village, phone, phone2, email, occupation, education, marital_status, notes, photo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW()) RETURNING *`,
      [memberId, name, dob, gender, religion, nationality, ninNumber, area, village, phone, phone2, email, occupation, education, maritalStatus, notes, photo]
    );
    
    const newMember = memberResult.rows[0];
    if (family && family.length > 0) {
      for (const fam of family) {
        await client.query(`INSERT INTO family_members (member_id, name, relation, dob, phone) VALUES ($1, $2, $3, $4, $5)`, [newMember.id, fam.name, fam.relation, fam.dob, fam.phone]);
      }
    }
    
    await client.query('COMMIT');
    const finalResult = await pool.query(`SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family FROM members m LEFT JOIN family_members f ON m.id = f.member_id WHERE m.id = $1 GROUP BY m.id`, [newMember.id]);
    res.json(finalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/members/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, dob, gender, religion, nationality, ninNumber, area, village, phone, phone2, email, occupation, education, maritalStatus, notes, photo, family } = req.body;
    
    await client.query(
      `UPDATE members SET name=$1, dob=$2, gender=$3, religion=$4, nationality=$5, nin_number=$6, area=$7, village=$8, phone=$9, phone2=$10, email=$11, occupation=$12, education=$13, marital_status=$14, notes=$15, photo=$16, updated_at=NOW() WHERE id=$17`,
      [name, dob, gender, religion, nationality, ninNumber, area, village, phone, phone2, email, occupation, education, maritalStatus, notes, photo, req.params.id]
    );
    
    await client.query('DELETE FROM family_members WHERE member_id = $1', [req.params.id]);
    if (family && family.length > 0) {
      for (const fam of family) {
        await client.query(`INSERT INTO family_members (member_id, name, relation, dob, phone) VALUES ($1, $2, $3, $4, $5)`, [req.params.id, fam.name, fam.relation, fam.dob, fam.phone]);
      }
    }
    
    await client.query('COMMIT');
    const finalResult = await pool.query(`SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family FROM members m LEFT JOIN family_members f ON m.id = f.member_id WHERE m.id = $1 GROUP BY m.id`, [req.params.id]);
    res.json(finalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/members/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM family_members WHERE member_id = $1', [req.params.id]);
    await client.query('DELETE FROM members WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============ STAFF API ============
app.get('/api/staff', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, staff_id, name, username, email, phone, role, active, permissions, avatar, created_at FROM staff ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staff', authenticateToken, async (req, res) => {
  try {
    const { name, username, password, email, phone, role, active, permissions, avatar } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const idResult = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM staff');
    const nextId = idResult.rows[0].next_id;
    const staffId = `STF-${String(nextId).padStart(4, '0')}`;
    
    const result = await pool.query(
      `INSERT INTO staff (staff_id, name, username, password, email, phone, role, active, permissions, avatar, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) RETURNING id, staff_id, name, username, email, phone, role, active, permissions, avatar`,
      [staffId, name, username, hashedPassword, email, phone, role, active !== false, permissions || [], avatar]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', authenticateToken, async (req, res) => {
  try {
    const { name, username, password, email, phone, role, active, permissions, avatar } = req.body;
    let query = `UPDATE staff SET name=$1, username=$2, email=$3, phone=$4, role=$5, active=$6, permissions=$7, avatar=$8, updated_at=NOW() WHERE id=$9`;
    let params = [name, username, email, phone, role, active !== false, permissions || [], avatar, req.params.id];
    
    if (password && password.length > 0) {
      const hashedPassword = await bcrypt.hash(password, 10);
      query = `UPDATE staff SET name=$1, username=$2, password=$3, email=$4, phone=$5, role=$6, active=$7, permissions=$8, avatar=$9, updated_at=NOW() WHERE id=$10`;
      params = [name, username, hashedPassword, email, phone, role, active !== false, permissions || [], avatar, req.params.id];
    }
    
    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE id = $1 AND role != $2', [req.params.id, 'superadmin']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM members');
    const males = await pool.query("SELECT COUNT(*) FROM members WHERE gender = 'Male'");
    const females = await pool.query("SELECT COUNT(*) FROM members WHERE gender = 'Female'");
    const thisMonth = await pool.query("SELECT COUNT(*) FROM members WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())");
    const byArea = await pool.query("SELECT area, COUNT(*) as count FROM members WHERE area IS NOT NULL GROUP BY area ORDER BY count DESC LIMIT 5");
    const recent = await pool.query("SELECT name, member_id, created_at, photo FROM members ORDER BY created_at DESC LIMIT 5");
    
    res.json({
      total: parseInt(total.rows[0].count),
      males: parseInt(males.rows[0].count),
      females: parseInt(females.rows[0].count),
      thisMonth: parseInt(thisMonth.rows[0].count),
      byArea: byArea.rows,
      recent: recent.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize database
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(200) NOT NULL,
        dob DATE,
        gender VARCHAR(10),
        religion VARCHAR(50),
        nationality VARCHAR(50),
        nin_number VARCHAR(50),
        area VARCHAR(100),
        village VARCHAR(100),
        phone VARCHAR(20),
        phone2 VARCHAR(20),
        email VARCHAR(100),
        occupation VARCHAR(100),
        education VARCHAR(100),
        marital_status VARCHAR(50),
        notes TEXT,
        photo TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS family_members (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        relation VARCHAR(50),
        dob DATE,
        phone VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        staff_id VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(200) NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        phone VARCHAR(20),
        role VARCHAR(50) DEFAULT 'staff',
        active BOOLEAN DEFAULT true,
        permissions JSONB DEFAULT '[]',
        avatar TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP
      )
    `);
    
// Fix: Ensure admin exists with correct password hash
const adminCheck = await pool.query("SELECT * FROM staff WHERE username = 'admin'");
if (adminCheck.rows.length === 0) {
  const hashedPassword = await bcrypt.hash('bmmu2025', 10);
  await pool.query(`
    INSERT INTO staff (staff_id, name, username, password, role, active, permissions, email)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, ['STF-0001', 'System Administrator', 'admin', hashedPassword, 'superadmin', true, '[]', 'admin@bmmu.go.ug']);
  console.log('Default admin created: admin / bmmu2025');
} else {
  // Force update the admin password hash (in case it was stored incorrectly)
  const hashedPassword = await bcrypt.hash('bmmu2025', 10);
  await pool.query(`
    UPDATE staff SET password = $1 WHERE username = 'admin'
  `, [hashedPassword]);
  console.log('Admin password hash updated');
}
    
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Serve HTML
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
});
