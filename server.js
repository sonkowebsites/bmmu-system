const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const AfricasTalking = require('africastalking');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============ EMAIL SETUP (Resend.com - works on Render free tier) ============
async function sendEmailViaResend(to, subject, html) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'BMMU System <onboarding@resend.dev>',
      to: [to],
      subject,
      html
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Failed to send email');
  return data;
}

// ============ AFRICA'S TALKING SETUP (SMS) ============
const AT = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});
const sms = AT.SMS;

// ============ OTP HELPERS ============
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendEmailOTP(email, otp, name) {
  await sendEmailViaResend(email, 'Your BMMU Login Code', `
      <div style="font-family:sans-serif;max-width:400px;margin:auto;padding:24px;border:1px solid #eee;border-radius:10px">
        <div style="text-align:center;margin-bottom:20px">
          <div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#5B6BF5,#8B5CF6);display:inline-flex;align-items:center;justify-content:center">
            <span style="color:#fff;font-size:24px;font-weight:800">B</span>
          </div>
          <h2 style="margin:10px 0 0;color:#1a1d2e">BMMU System</h2>
        </div>
        <p style="color:#444">Hello <strong>${name}</strong>,</p>
        <p style="color:#444">Your one-time login code is:</p>
        <div style="text-align:center;margin:24px 0">
          <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#5B6BF5">${otp}</span>
        </div>
        <p style="color:#888;font-size:13px">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="color:#aaa;font-size:11px;text-align:center">Buganda Muslim Mass Union · Republic of Uganda</p>
      </div>
    `
  });
}

async function sendSmsOTP(phone, otp, name) {
  // Format phone for Uganda: ensure it starts with +256
  let formatted = phone.replace(/\s/g, '');
  if (formatted.startsWith('0')) formatted = '+256' + formatted.slice(1);
  if (!formatted.startsWith('+')) formatted = '+' + formatted;

  await sms.send({
    to: [formatted],
    message: `BMMU System: Hello ${name}, your login code is ${otp}. Valid for 10 minutes. Do not share.`,
    from: 'BMMU'
  });
}

// ============ OTP API ============

// Request OTP (by email or phone)
app.post('/api/otp/request', async (req, res) => {
  try {
    const { value, method } = req.body;
    // method = 'email' or 'phone'

    if (!value || !method) {
      return res.status(400).json({ error: 'Email/phone and method required' });
    }

    // Find staff member by email or phone
    let staff;
    if (method === 'email') {
      const result = await pool.query(
        'SELECT * FROM staff WHERE LOWER(email) = LOWER($1) AND active = true',
        [value.trim()]
      );
      staff = result.rows[0];
    } else {
      // Normalize phone for search
      const normalized = value.trim().replace(/\s/g, '');
      const result = await pool.query(
        'SELECT * FROM staff WHERE REPLACE(phone, \' \', \'\') = $1 AND active = true',
        [normalized]
      );
      staff = result.rows[0];
    }

    if (!staff) {
      return res.status(404).json({ error: `No active account found with that ${method}.` });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save OTP to database
    await pool.query(
      `INSERT INTO otp_codes (staff_id, code, method, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [staff.id, otp, method, expiresAt]
    );

    // Send OTP
    if (method === 'email') {
      await sendEmailOTP(staff.email, otp, staff.name);
    } else {
      await sendSmsOTP(staff.phone, otp, staff.name);
    }

    // Return masked contact for display
    let masked;
    if (method === 'email') {
      const [user, domain] = staff.email.split('@');
      masked = user.slice(0, 2) + '***@' + domain;
    } else {
      masked = staff.phone.slice(0, -4).replace(/\d/g, '*') + staff.phone.slice(-4);
    }

    res.json({ success: true, masked, staffId: staff.id });
  } catch (err) {
    console.error('OTP request error:', err);
    res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
  }
});

// Verify OTP
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { staffId, code } = req.body;

    if (!staffId || !code) {
      return res.status(400).json({ error: 'Staff ID and code required' });
    }

    // Find valid OTP
    const result = await pool.query(
      `SELECT * FROM otp_codes 
       WHERE staff_id = $1 AND code = $2 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [staffId, code.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired code. Please request a new one.' });
    }

    // Mark OTP as used
    await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [result.rows[0].id]);

    // Get staff member
    const staffResult = await pool.query('SELECT * FROM staff WHERE id = $1', [staffId]);
    const user = staffResult.rows[0];
    delete user.password;

    res.json(user);
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ MEMBERS API ============

app.get('/api/members', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, 
             COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m
      LEFT JOIN family_members f ON m.id = f.member_id
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/members/:id', async (req, res) => {
  try {
    const memberResult = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const familyResult = await pool.query('SELECT * FROM family_members WHERE member_id = $1', [req.params.id]);
    const member = memberResult.rows[0];
    member.family = familyResult.rows;
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/members', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, dob, gender, religion, nationality, ninNumber, area, village,
            phone, phone2, email, occupation, education, maritalStatus, notes, photo, family } = req.body;
    const idResult = await client.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM members');
    const nextId = idResult.rows[0].next_id;
    const memberId = `BMMU-${String(nextId).padStart(5, '0')}`;
    const memberResult = await client.query(
      `INSERT INTO members (member_id, name, dob, gender, religion, nationality, nin_number, area,
       village, phone, phone2, email, occupation, education, marital_status, notes, photo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
       RETURNING *`,
      [memberId, name, dob, gender, religion, nationality, ninNumber, area, village, phone,
       phone2, email, occupation, education, maritalStatus, notes, photo]
    );
    const newMember = memberResult.rows[0];
    if (family && family.length > 0) {
      for (const fam of family) {
        await client.query(
          `INSERT INTO family_members (member_id, name, relation, dob, phone) VALUES ($1, $2, $3, $4, $5)`,
          [newMember.id, fam.name, fam.relation, fam.dob, fam.phone]
        );
      }
    }
    await client.query('COMMIT');
    const finalResult = await pool.query(`
      SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m LEFT JOIN family_members f ON m.id = f.member_id
      WHERE m.id = $1 GROUP BY m.id
    `, [newMember.id]);
    res.json(finalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/members/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, dob, gender, religion, nationality, ninNumber, area, village,
            phone, phone2, email, occupation, education, maritalStatus, notes, photo, family } = req.body;
    await client.query(
      `UPDATE members SET name=$1, dob=$2, gender=$3, religion=$4, nationality=$5,
       nin_number=$6, area=$7, village=$8, phone=$9, phone2=$10, email=$11,
       occupation=$12, education=$13, marital_status=$14, notes=$15, photo=$16, updated_at=NOW()
       WHERE id=$17`,
      [name, dob, gender, religion, nationality, ninNumber, area, village, phone, phone2,
       email, occupation, education, maritalStatus, notes, photo, req.params.id]
    );
    await client.query('DELETE FROM family_members WHERE member_id = $1', [req.params.id]);
    if (family && family.length > 0) {
      for (const fam of family) {
        await client.query(
          `INSERT INTO family_members (member_id, name, relation, dob, phone) VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, fam.name, fam.relation, fam.dob, fam.phone]
        );
      }
    }
    await client.query('COMMIT');
    const finalResult = await pool.query(`
      SELECT m.*, COALESCE(json_agg(f.*) FILTER (WHERE f.id IS NOT NULL), '[]') as family
      FROM members m LEFT JOIN family_members f ON m.id = f.member_id
      WHERE m.id = $1 GROUP BY m.id
    `, [req.params.id]);
    res.json(finalResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/members/:id', async (req, res) => {
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

app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM staff ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staff', async (req, res) => {
  try {
    const { name, username, password, email, phone, role, active, permissions, avatar } = req.body;
    const idResult = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM staff');
    const nextId = idResult.rows[0].next_id;
    const staffId = `STF-${String(nextId).padStart(4, '0')}`;
    const result = await pool.query(
      `INSERT INTO staff (staff_id, name, username, password, email, phone, role, active, permissions, avatar, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) RETURNING *`,
      [staffId, name, username, password, email, phone, role, active !== false, permissions || [], avatar]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, username, password, email, phone, role, active, permissions, avatar } = req.body;
    await pool.query(
      `UPDATE staff SET name=$1, username=$2, password=$3, email=$4, phone=$5,
       role=$6, active=$7, permissions=$8, avatar=$9, updated_at=NOW() WHERE id=$10`,
      [name, username, password, email, phone, role, active !== false, permissions || [], avatar, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM staff WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login (username + password — kept for admin)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT * FROM staff WHERE username = $1 AND password = $2 AND active = true',
      [username, password]
    );
    if (result.rows.length > 0) {
      const user = result.rows[0];
      delete user.password;
      res.json(user);
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STATISTICS ============

app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM members');
    const males = await pool.query("SELECT COUNT(*) FROM members WHERE gender = 'Male'");
    const females = await pool.query("SELECT COUNT(*) FROM members WHERE gender = 'Female'");
    const thisMonth = await pool.query(
      "SELECT COUNT(*) FROM members WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())"
    );
    const byArea = await pool.query(
      "SELECT area, COUNT(*) as count FROM members WHERE area IS NOT NULL GROUP BY area ORDER BY count DESC"
    );
    const byGender = await pool.query("SELECT gender, COUNT(*) as count FROM members GROUP BY gender");
    res.json({
      total: parseInt(total.rows[0].count),
      males: parseInt(males.rows[0].count),
      females: parseInt(females.rows[0].count),
      thisMonth: parseInt(thisMonth.rows[0].count),
      byArea: byArea.rows,
      byGender: byGender.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ DATABASE INIT ============

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

    // OTP codes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
        code VARCHAR(6) NOT NULL,
        method VARCHAR(10) NOT NULL,
        used BOOLEAN DEFAULT false,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const adminCheck = await pool.query("SELECT * FROM staff WHERE username = 'admin'");
    if (adminCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO staff (staff_id, name, username, password, role, active, permissions)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, ['STF-0001', 'System Administrator', 'admin', 'bmmu2025', 'superadmin', true, '[]']);
      console.log('Default admin created: admin / bmmu2025');
    }

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

initDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
